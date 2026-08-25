import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import {
  addressHash, admitScan, availableServices, cancelQuote, classifyAddressChange,
  freeCancelUntil, newId, POLICY, reconcile, resolveUnsealApprover, sha256Hex,
  validateItem, type Address, type ItemType, type Role, type ScannedLine,
} from '@custode/core';
import { problem, requires } from '../auth.js';
import { append, verify } from '../ledger.js';
import { tx } from '../db.js';

/**
 * The packing desk vertical (spec §4.3, §4.4): box → ticket → scan → address →
 * seal → book, plus unseal dual control and the ledger endpoints.
 */

const mask = (s: string | null | undefined) =>
  s ? `•••• ${String(s).replace(/\D/g, '').slice(-4)}` : '•••• ????';

async function getLines(q: pg.Pool | pg.PoolClient, boxId: string): Promise<ScannedLine[]> {
  const { rows } = await q.query(
    `SELECT code, item_type, label, qty, value_cents FROM custode.manifest_line
      WHERE box_id = $1 ORDER BY scanned_at`, [boxId]);
  return rows as ScannedLine[];
}

async function getExpected(q: pg.Pool | pg.PoolClient, ticketId: string | null) {
  if (!ticketId) return null;
  const { rows } = await q.query(
    `SELECT code, qty FROM custode.ticket_expected_line WHERE ticket_id = $1`, [ticketId]);
  return rows as { code: string; qty: number }[];
}

async function loadBox(q: pg.Pool | pg.PoolClient, id: string) {
  const { rows } = await q.query(`SELECT * FROM custode.box WHERE id = $1 OR box_ref = $1`, [id]);
  return rows[0] ?? null;
}

async function draftMovement(q: pg.Pool | pg.PoolClient, boxId: string) {
  const { rows } = await q.query(
    `SELECT * FROM custode.movement WHERE box_id = $1
      ORDER BY booked_at DESC LIMIT 1`, [boxId]);
  return rows[0] ?? null;
}

async function loadAddress(q: pg.Pool | pg.PoolClient, id: string): Promise<(Address & { hash_salt: string }) | null> {
  const { rows } = await q.query(
    `SELECT unit, line1, city, province, postal, note, hash_salt FROM pii.address WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export function packingRoutes(app: FastifyInstance, pool: pg.Pool) {
  // -------------------------------------------------------------- create box
  app.post('/v1/boxes', { preHandler: requires('box.pack') }, async (req, reply) => {
    const { ticket_ref } = (req.body ?? {}) as { ticket_ref?: string };
    const { store_id, provider_id, actor } = req.auth;
    if (!store_id || !provider_id) {
      return problem(reply, 403, 'store_scope_required', 'Packing needs a store-scoped principal.');
    }

    return tx(pool, async (c) => {
      await c.query(`SET LOCAL custode.actor_role = 'SUPER_ADMIN'`); // trigger context for reads
      const boxId = newId('box');
      const { rows: [{ nextval }] } = await c.query(`SELECT nextval('custode.box_ref_seq')`);
      const boxRef = `BX-${nextval}`;

      let ticket = null;
      if (ticket_ref) {
        const t = await c.query(
          `SELECT * FROM custode.ticket WHERE provider_id = $1 AND external_ref = $2`,
          [provider_id, ticket_ref.trim().toUpperCase()]);
        ticket = t.rows[0] ?? null;
        if (!ticket) return problem(reply, 404, 'ticket_not_found', `No open ticket ${ticket_ref}.`);
      }

      await c.query(
        `INSERT INTO custode.box (id, box_ref, store_id, ticket_id, packed_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [boxId, boxRef, store_id, ticket?.id ?? null, actor.user_id]);

      let movement: Record<string, unknown> | null = null;
      if (ticket) {
        movement = await createDraftFromTicket(c, {
          ticket, boxId, provider_id, store_id, actor,
        });
      }

      await append(c, {
        type: 'session.opened',
        detail: { box_ref: boxRef, ticket_ref: ticket?.external_ref ?? null },
        actor, box_id: boxId, provider_id, store_id,
        movement_id: (movement?.id as string) ?? null,
      });

      reply.status(201);
      return ({
        box: { id: boxId, box_ref: boxRef, status: 'OPEN', ticket_ref: ticket?.external_ref ?? null },
        movement,
      });
    });
  });

  async function createDraftFromTicket(c: pg.PoolClient, args: {
    ticket: Record<string, unknown>; boxId: string; provider_id: string; store_id: string;
    actor: { user_id: string | null; role: string; label: string };
  }) {
    const raw = (args.ticket.raw_payload ?? {}) as {
      recipient?: { full_name?: string; phone?: string; email?: string; locale?: string };
      address?: Address;
    };
    const rcp = raw.recipient ?? {};
    const adr = raw.address ?? null;
    if (!adr) return null; // rung-4 ticket: recipient captured later

    const recipientId = newId('rcp');
    const fetchedId = newId('adr');
    const shippedId = newId('adr');
    const salt = newId('slt');

    await c.query(
      `INSERT INTO pii.recipient (id, full_name, phone_e164, email, locale)
       VALUES ($1,$2,$3,$4,$5)`,
      [recipientId, rcp.full_name ?? null, rcp.phone ?? null, rcp.email ?? null,
       rcp.locale === 'en-CA' ? 'en-CA' : 'fr-CA']);
    for (const id of [fetchedId, shippedId]) {
      await c.query(
        `INSERT INTO pii.address (id, unit, line1, city, province, postal, note, hash_salt)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, adr.unit ?? null, adr.line1, adr.city, adr.province ?? 'QC', adr.postal,
         adr.note ?? null, salt]);
    }

    const movId = newId('mov');
    const { rows: [{ nextval }] } = await c.query(`SELECT nextval('custode.movement_ref_seq')`);
    await c.query(
      `INSERT INTO custode.movement
         (id, movement_ref, provider_id, store_id, box_id, ticket_id, service_code,
          price_cents, declared_cents, status, recipient_id, address_id,
          address_fetched_id, address_hash)
       VALUES ($1,$2,$3,$4,$5,$6,'CUSTODE_24',0,0,'DRAFT',$7,$8,$9,$10)`,
      [movId, `M-${nextval}`, args.provider_id, args.store_id, args.boxId, args.ticket.id,
       recipientId, shippedId, fetchedId, addressHash(adr, salt)]);

    await append(c, {
      type: 'ticket.attached',
      detail: { ticket_ref: args.ticket.external_ref, source: args.ticket.source },
      actor: args.actor, box_id: args.boxId, movement_id: movId,
      provider_id: args.provider_id, store_id: args.store_id,
    });
    return { id: movId, movement_ref: `M-${nextval}`, status: 'DRAFT',
             recipient: { full_name: rcp.full_name, phone_masked: mask(rcp.phone) },
             address: adr };
  }

  // -------------------------------------------------------------------- scan
  app.post('/v1/boxes/:id/scan', { preHandler: requires('box.pack') }, async (req, reply) => {
    const { code } = (req.body ?? {}) as { code?: string };
    if (!code?.trim()) return problem(reply, 422, 'code_required', 'Scan payload needs a code.');
    const raw = code.trim();

    return tx(pool, async (c) => {
      const box = await loadBox(c, (req.params as { id: string }).id);
      if (!box) return problem(reply, 404, 'box_not_found', 'No such box.');
      const { actor, provider_id, store_id } = req.auth;

      const cat = await c.query(
        `SELECT item_type, label_fr, value_cents FROM custode.catalogue_item
          WHERE provider_id = $1 AND code = $2 AND active`, [provider_id, raw]);
      const catalogue = cat.rows[0]
        ? { item_type: cat.rows[0].item_type as ItemType } : null;

      const existing = await getLines(c, box.id);
      const elsewhere = catalogue && await c.query(
        `SELECT 1 FROM custode.manifest_line ml
           JOIN custode.movement m ON m.box_id = ml.box_id
          WHERE ml.code = $1 AND ml.box_id <> $2
            AND m.status IN ('BOOKED','OFFERED','ASSIGNED','PICKED_UP','EXCEPTION')
          LIMIT 1`, [raw, box.id]);

      const outcome = admitScan(raw, {
        box_status: box.status,
        existing,
        serialized_elsewhere: !!elsewhere?.rowCount,
        catalogue,
      });

      if (outcome.action === 'REJECT') {
        await append(c, { type: 'item.rejected', detail: { code: raw, reason: outcome.reason },
          actor, box_id: box.id, provider_id, store_id });
        return problem(reply, 409, outcome.reason,
          outcome.reason === 'manifest_locked'
            ? 'The manifest is sealed — adding an item needs a new seal.'
            : `${raw} cannot be added to this box.`, { code_scanned: raw });
      }
      if (outcome.action === 'CAPTURE_UNKNOWN') {
        return problem(reply, 422, 'unknown_barcode',
          'Not in the catalogue. Record it with a description and photo — never block the counter.',
          { code_scanned: raw, next: `POST /v1/boxes/${box.id}/scan/unknown` });
      }

      const itemType = catalogue!.item_type;
      const v = validateItem(raw, itemType);
      if (!v.ok) {
        return problem(reply, 422, 'item_validation_failed',
          `${raw} failed ${itemType} validation (${v.reason}).`,
          { item: { code: raw, item_type: itemType, reason: v.reason } });
      }

      const label = cat.rows[0].label_fr as string;
      const value = cat.rows[0].value_cents as number;
      if (outcome.action === 'INCREMENT') {
        await c.query(`UPDATE custode.manifest_line SET qty = $1 WHERE box_id = $2 AND code = $3`,
          [outcome.qty, box.id, raw]);
      } else {
        await c.query(
          `INSERT INTO custode.manifest_line (id, box_id, code, item_type, label, qty, value_cents, scanned_by)
           VALUES ($1,$2,$3,$4,$5,1,$6,$7)`,
          [newId('mln'), box.id, raw, itemType, label, value, actor.user_id]);
      }
      await append(c, {
        type: 'item.scanned',
        detail: { code: raw, item_type: itemType, qty: outcome.qty, value_cents: value },
        actor, box_id: box.id, provider_id, store_id,
      });

      const r = reconcile(await getLines(c, box.id), await getExpected(c, box.ticket_id));
      return ({ line: { code: raw, item_type: itemType, label, qty: outcome.qty }, reconcile: r });
    });
  });

  app.post('/v1/boxes/:id/scan/unknown', { preHandler: requires('box.pack') }, async (req, reply) => {
    const { code, description, photo_blob_id } =
      (req.body ?? {}) as { code?: string; description?: string; photo_blob_id?: string };
    if (!code?.trim() || !description?.trim() || !photo_blob_id) {
      return problem(reply, 422, 'unknown_capture_incomplete',
        'An unknown item needs its code, a description and a photo.');
    }
    return tx(pool, async (c) => {
      const box = await loadBox(c, (req.params as { id: string }).id);
      if (!box) return problem(reply, 404, 'box_not_found', 'No such box.');
      if (box.status !== 'OPEN') return problem(reply, 409, 'manifest_locked', 'The manifest is sealed.');
      const { actor, provider_id, store_id } = req.auth;
      await c.query(
        `INSERT INTO custode.manifest_line
           (id, box_id, code, item_type, label, qty, value_cents, scanned_by, photo_blob_id)
         VALUES ($1,$2,$3,'UNKNOWN',$4,1,0,$5,$6)`,
        [newId('mln'), box.id, code.trim(), `${description.trim()} · unverified`,
         actor.user_id, photo_blob_id]);
      await append(c, {
        type: 'item.unknown_recorded',
        detail: { code: code.trim(), description: description.trim(), photo_blob_id },
        actor, box_id: box.id, provider_id, store_id,
      });
      return ({ recorded: true });
    });
  });

  // ----------------------------------------------------------------- address
  app.put('/v1/movements/:id/address', { preHandler: requires('address.override') }, async (req, reply) => {
    const body = (req.body ?? {}) as Partial<Address> & { reason?: string };
    return tx(pool, async (c) => {
      const mv = (await c.query(`SELECT * FROM custode.movement WHERE id = $1`,
        [(req.params as { id: string }).id])).rows[0];
      if (!mv) return problem(reply, 404, 'movement_not_found', 'No such movement.');
      const box = await loadBox(c, mv.box_id);
      const fetched = await loadAddress(c, mv.address_fetched_id);
      const shippedRow = await loadAddress(c, mv.address_id);
      if (!fetched || !shippedRow) return problem(reply, 409, 'address_missing', 'No address on file.');

      const next: Address = {
        unit: body.unit ?? shippedRow.unit, line1: body.line1 ?? shippedRow.line1,
        city: body.city ?? shippedRow.city, province: shippedRow.province,
        postal: body.postal ?? shippedRow.postal, note: body.note ?? shippedRow.note,
      };
      // What does THIS edit change? Measured against the current shipped
      // address — otherwise a harmless buzzer note added after a legitimate
      // street override would demand a reason forever.
      const cls = classifyAddressChange({
        fetched: shippedRow, shipped: next, declared_cents: box.declared_cents,
        box_status: box.status, movement_status: mv.status,
        actor_role: req.auth.actor.role as Role,
      });
      if (!cls.allowed) {
        return problem(reply, 409, cls.code,
          cls.code === 'requires_unseal'
            ? 'The box is sealed — changing the address needs an unseal.'
            : 'In custody — only a dispatcher may change the destination.');
      }
      if (cls.kind === 'NO_CHANGE') return ({ changed: false });
      if (cls.reason_required && !body.reason?.trim()) {
        return problem(reply, 422, 'reason_required_for_material_change',
          'Changing street, city or postal code needs a reason.');
      }

      await c.query(
        `UPDATE pii.address SET unit=$1, line1=$2, city=$3, postal=$4, note=$5 WHERE id=$6`,
        [next.unit ?? null, next.line1, next.city, next.postal, next.note ?? null, mv.address_id]);

      const material = cls.kind === 'OVERRIDE';
      const { diffAddress } = await import('@custode/core');
      const d = diffAddress(shippedRow, next);          // this edit's delta
      const cumulative = diffAddress(fetched, next);    // drift from the CRM record
      await c.query(
        `INSERT INTO custode.address_override (id, movement_id, fields, material, reason, changed_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [newId('ovr'), mv.id, d.fields, material, body.reason ?? null, req.auth.actor.user_id]);
      await c.query(
        `UPDATE custode.movement SET address_hash=$1, address_overridden = address_overridden OR $2
          WHERE id=$3`,
        [addressHash(next, shippedRow.hash_salt), cumulative.material, mv.id]);

      const wasConfirmed = !!mv.address_confirmed_at;
      if (wasConfirmed) {
        await c.query(
          `UPDATE custode.movement SET address_confirmed_by=NULL, address_confirmed_at=NULL WHERE id=$1`,
          [mv.id]);
      }
      await append(c, {
        type: material ? 'address.overridden' : 'address.corrected',
        detail: { fields: d.fields, material, reason: body.reason ?? null },
        actor: req.auth.actor, movement_id: mv.id, box_id: mv.box_id,
        provider_id: mv.provider_id, store_id: mv.store_id,
      });
      if (wasConfirmed) {
        await append(c, {
          type: 'address.unconfirmed', detail: { reason: 'changed_after_confirmation' },
          actor: req.auth.actor, movement_id: mv.id, box_id: mv.box_id,
          provider_id: mv.provider_id, store_id: mv.store_id,
        });
      }
      return ({ changed: true, material, confirmation_cleared: wasConfirmed });
    });
  });

  app.post('/v1/movements/:id/address/confirm', { preHandler: requires('box.pack') }, async (req, reply) => {
    return tx(pool, async (c) => {
      const mv = (await c.query(`SELECT * FROM custode.movement WHERE id = $1`,
        [(req.params as { id: string }).id])).rows[0];
      if (!mv) return problem(reply, 404, 'movement_not_found', 'No such movement.');
      await c.query(
        `UPDATE custode.movement SET address_confirmed_by=$1, address_confirmed_at=now() WHERE id=$2`,
        [req.auth.actor.user_id, mv.id]);
      await append(c, {
        type: 'address.confirmed', detail: { address_hash: mv.address_hash },
        actor: req.auth.actor, movement_id: mv.id, box_id: mv.box_id,
        provider_id: mv.provider_id, store_id: mv.store_id,
      });
      return ({ confirmed: true });
    });
  });

  // -------------------------------------------------------------------- seal
  app.post('/v1/boxes/:id/seal', { preHandler: requires('box.seal') }, async (req, reply) => {
    const { seal_no, discrepancy_reason } =
      (req.body ?? {}) as { seal_no?: string; discrepancy_reason?: string };
    if (!seal_no?.trim()) return problem(reply, 422, 'seal_required', 'Provide the seal number.');

    return tx(pool, async (c) => {
      const box = await loadBox(c, (req.params as { id: string }).id);
      if (!box) return problem(reply, 404, 'box_not_found', 'No such box.');
      if (box.status !== 'OPEN') return problem(reply, 409, 'manifest_locked', 'Already sealed.');
      if (!box.ticket_id) return problem(reply, 409, 'ticket_required', 'Attach a ticket before sealing.');

      const lines = await getLines(c, box.id);
      if (!lines.length) return problem(reply, 409, 'empty_box', 'Nothing scanned into the box.');

      const mv = await draftMovement(c, box.id);
      if (!mv?.address_confirmed_at) {
        return problem(reply, 409, 'address_not_confirmed',
          'Confirm the delivery address before sealing — an active confirmation is evidence.');
      }

      const seal = (await c.query(
        `SELECT s.*, r.store_id AS range_store FROM custode.seal s
           JOIN custode.seal_range r ON r.id = s.range_id
          WHERE s.seal_no = $1`, [seal_no.trim()])).rows[0];
      if (!seal) return problem(reply, 409, 'seal_out_of_range',
        'Not a CUSTODE seal from a controlled range — a substituted seal must be detectable.');
      if (seal.status === 'VOIDED') return problem(reply, 409, 'seal_voided', 'That seal was voided.');
      if (seal.status !== 'ISSUED') return problem(reply, 409, 'seal_already_used', 'That seal is used.');
      if (seal.range_store && seal.range_store !== box.store_id) {
        return problem(reply, 409, 'seal_out_of_range', 'That seal was issued to another store.');
      }

      const r = reconcile(lines, await getExpected(c, box.ticket_id));
      if (r.needs_reason && !discrepancy_reason?.trim()) {
        return problem(reply, 422, 'discrepancy_reason_required',
          'The box does not match the ticket. Sealing anyway needs a reason — it locks the discrepancy in.',
          { reconcile: { missing: r.missing, short: r.short, over: r.over, extra: r.extra } });
      }

      const cap = (await c.query(
        `SELECT declared_cap_cents FROM custode.provider WHERE id = $1`,
        [mv.provider_id])).rows[0].declared_cap_cents;
      if (r.declared_cents > cap) {
        return problem(reply, 409, 'declared_cap_exceeded',
          `Declared value exceeds this provider's ceiling.`, { declared_cents: r.declared_cents, cap_cents: cap });
      }

      await c.query(`UPDATE custode.seal SET status='APPLIED', applied_at=now() WHERE id=$1`, [seal.id]);
      await c.query(
        `UPDATE custode.box SET status='SEALED', current_seal_id=$1, seal_count=seal_count+1,
                sealed_at=now(), declared_cents=$2 WHERE id=$3`,
        [seal.id, r.declared_cents, box.id]);
      await c.query(`UPDATE custode.movement SET declared_cents=$1 WHERE id=$2`,
        [r.declared_cents, mv.id]);

      await append(c, {
        type: 'box.sealed',
        detail: { box_ref: box.box_ref, seal_no: seal.seal_no, line_count: r.lines.length,
                  unit_count: r.units, declared_cents: r.declared_cents,
                  discrepancy: discrepancy_reason?.trim() || undefined },
        actor: req.auth.actor, box_id: box.id, movement_id: mv.id,
        provider_id: mv.provider_id, store_id: box.store_id,
      });
      await append(c, {
        type: 'manifest.locked', detail: { box_ref: box.box_ref },
        actor: req.auth.actor, box_id: box.id, movement_id: mv.id,
        provider_id: mv.provider_id, store_id: box.store_id,
      });
      return ({
        box: { id: box.id, box_ref: box.box_ref, status: 'SEALED', seal_no: seal.seal_no,
               seal_count: box.seal_count + 1, declared_cents: r.declared_cents },
      });
    });
  });

  // -------------------------------------------------------------------- book
  app.post('/v1/movements/:id/book', { preHandler: requires('movement.book') }, async (req, reply) => {
    const { service_code } = (req.body ?? {}) as { service_code?: string };
    return tx(pool, async (c) => {
      const mv = (await c.query(`SELECT * FROM custode.movement WHERE id = $1`,
        [(req.params as { id: string }).id])).rows[0];
      if (!mv) return problem(reply, 404, 'movement_not_found', 'No such movement.');
      if (mv.status !== 'DRAFT') return problem(reply, 409, 'already_booked', `Movement is ${mv.status}.`);
      const box = await loadBox(c, mv.box_id);
      if (box.status !== 'SEALED') return problem(reply, 409, 'box_not_sealed', 'Seal the box first.');

      const store = (await c.query(`SELECT timezone, cutoff_local FROM custode.store WHERE id=$1`,
        [mv.store_id])).rows[0];
      const services = (await c.query(
        `SELECT code, name, window_label, price_cents, morning_only, sort_order
           FROM custode.service WHERE active ORDER BY sort_order`)).rows;
      const avail = availableServices({
        at: new Date(), timeZone: store.timezone,
        cutoffLocal: String(store.cutoff_local).slice(0, 5),
        services: services.map((s) => ({ ...s, morning_only: s.morning_only })),
      });
      const chosen = avail.find((s) => s.code === (service_code ?? 'CUSTODE_24'));
      if (!chosen) return problem(reply, 422, 'unknown_service', 'No such service.');
      if (!chosen.available) {
        return problem(reply, 422, 'service_past_cutoff',
          `${chosen.name} cannot be served today — cutoff passed. Selling a window we cannot serve is worse than refusing it.`,
          { available: avail.filter((s) => s.available).map((s) => s.code) });
      }

      const now = new Date();
      await c.query(
        `UPDATE custode.movement
            SET status='OFFERED', service_code=$1, price_cents=$2,
                booked_at=$3, free_cancel_until=$4
          WHERE id=$5`,
        [chosen.code, chosen.price_cents, now, freeCancelUntil(now), mv.id]);

      await append(c, {
        type: 'movement.booked',
        detail: { movement_ref: mv.movement_ref, service_code: chosen.code,
                  price_cents: chosen.price_cents },
        actor: req.auth.actor, movement_id: mv.id, box_id: mv.box_id,
        provider_id: mv.provider_id, store_id: mv.store_id,
      });
      await append(c, {
        type: 'movement.offered', detail: { free_cancel_minutes: POLICY.freeCancelMinutes },
        actor: req.auth.actor, movement_id: mv.id, box_id: mv.box_id,
        provider_id: mv.provider_id, store_id: mv.store_id,
      });
      reply.status(201);
      return ({
        movement: { id: mv.id, movement_ref: mv.movement_ref, status: 'OFFERED',
                    service_code: chosen.code, price_cents: chosen.price_cents,
                    free_cancel_until: freeCancelUntil(now).toISOString() },
      });
    });
  });

  // ------------------------------------------------------------------ cancel
  app.post('/v1/movements/:id/cancel', { preHandler: requires('movement.cancel') }, async (req, reply) => {
    return tx(pool, async (c) => {
      const mv = (await c.query(`SELECT * FROM custode.movement WHERE id = $1`,
        [(req.params as { id: string }).id])).rows[0];
      if (!mv) return problem(reply, 404, 'movement_not_found', 'No such movement.');
      const q = cancelQuote({ status: mv.status, booked_at: new Date(mv.booked_at) }, new Date());
      if (!q.allowed) return problem(reply, 409, q.reason, q.note ?? 'Cannot cancel.');
      await c.query(
        `UPDATE custode.movement SET status='CANCELLED', cancel_fee_cents=$1, closed_at=now() WHERE id=$2`,
        [q.fee_cents, mv.id]);
      await append(c, {
        type: 'movement.cancelled', detail: { fee_cents: q.fee_cents, by_role: req.auth.actor.role },
        actor: req.auth.actor, movement_id: mv.id, box_id: mv.box_id,
        provider_id: mv.provider_id, store_id: mv.store_id,
      });
      return ({ ok: true, fee_cents: q.fee_cents });
    });
  });

  // ------------------------------------------------------------------ unseal
  app.post('/v1/boxes/:id/unseal/request', { preHandler: requires('box.unseal.request') }, async (req, reply) => {
    const { reason } = (req.body ?? {}) as { reason?: string };
    if (!reason?.trim()) return problem(reply, 422, 'reason_required', 'Why is the box being opened?');

    return tx(pool, async (c) => {
      const box = await loadBox(c, (req.params as { id: string }).id);
      if (!box) return problem(reply, 404, 'box_not_found', 'No such box.');
      if (box.status !== 'SEALED') return problem(reply, 409, 'box_not_sealed', 'The box is not sealed.');
      if (box.unseal_locked) return problem(reply, 423, 'unseal_locked',
        'Too many failed codes — only CUSTODE admin can open this box.');

      const staff = (await c.query(
        `SELECT id AS user_id, role, store_id, display_name, phone_e164
           FROM custode.app_user WHERE store_id = $1 AND status = 'ACTIVE'`,
        [box.store_id])).rows;
      const approver = resolveUnsealApprover(
        { user_id: req.auth.actor.user_id ?? '', store_id: box.store_id },
        staff.map((s) => ({ user_id: s.user_id, role: s.role as Role, store_id: s.store_id })),
      );
      if (!approver) {
        return problem(reply, 409, 'no_approver_on_shift',
          'No second manager at this store — the request escalates to CUSTODE dispatch. ' +
          'A code sent to the person opening the box proves only that they hold their own phone.');
      }
      const approverRow = staff.find((s) => s.user_id === approver.user_id)!;

      const code = String(randomInt(100000, 1000000));
      const otpId = newId('otp');
      await c.query(
        `INSERT INTO custode.otp (id, box_id, purpose, code_hash, expires_at, approver_user_id, sent_to)
         VALUES ($1,$2,'UNSEAL',$3, now() + interval '10 minutes', $4, $5)`,
        [otpId, box.id, sha256Hex(code), approver.user_id, mask(approverRow.phone_e164)]);

      const seal = (await c.query(`SELECT seal_no FROM custode.seal WHERE id=$1`,
        [box.current_seal_id])).rows[0];
      await append(c, {
        type: 'unseal.requested', detail: { seal_no: seal.seal_no, reason: reason.trim() },
        actor: req.auth.actor, box_id: box.id, store_id: box.store_id,
      });
      await append(c, {
        type: 'unseal.code.sent',
        detail: { approver_user_id: approver.user_id, sent_to_masked: mask(approverRow.phone_e164),
                  ttl_seconds: 600 },
        actor: req.auth.actor, box_id: box.id, store_id: box.store_id,
      });

      const sandbox = await isSandboxKey(c, req);
      reply.status(202);
      return ({
        approver: { display_name: approverRow.display_name, role: approverRow.role,
                    sent_to_masked: mask(approverRow.phone_e164) },
        ttl_seconds: 600, attempts_allowed: POLICY.otpMaxAttempts,
        ...(sandbox ? { sandbox_code: code } : {}),
      });
    });
  });

  app.post('/v1/boxes/:id/unseal/confirm', { preHandler: requires('box.unseal.request') }, async (req, reply) => {
    const { code } = (req.body ?? {}) as { code?: string };
    if (!code || !/^\d{6}$/.test(code)) return problem(reply, 422, 'code_format', 'Six digits.');

    return tx(pool, async (c) => {
      const box = await loadBox(c, (req.params as { id: string }).id);
      if (!box) return problem(reply, 404, 'box_not_found', 'No such box.');
      if (box.unseal_locked) return problem(reply, 423, 'unseal_locked', 'Locked.');

      const otp = (await c.query(
        `SELECT * FROM custode.otp
          WHERE box_id = $1 AND purpose = 'UNSEAL' AND consumed_at IS NULL
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [box.id])).rows[0];
      if (!otp || new Date(otp.expires_at) < new Date()) {
        return problem(reply, 410, 'code_expired', 'Request a fresh code.');
      }

      if (sha256Hex(code) !== otp.code_hash) {
        const attempts = otp.attempts + 1;
        await c.query(`UPDATE custode.otp SET attempts=$1 WHERE id=$2`, [attempts, otp.id]);
        await append(c, {
          type: 'unseal.code.failed', detail: { attempt: attempts, of: POLICY.otpMaxAttempts },
          actor: req.auth.actor, box_id: box.id, store_id: box.store_id,
        });
        if (attempts >= POLICY.otpMaxAttempts) {
          await c.query(`UPDATE custode.box SET unseal_locked=true WHERE id=$1`, [box.id]);
          await append(c, {
            type: 'unseal.locked', detail: { attempts },
            actor: req.auth.actor, box_id: box.id, store_id: box.store_id,
          });
          return problem(reply, 423, 'unseal_locked',
            'Five failed codes — only CUSTODE admin can open this box now.');
        }
        return problem(reply, 401, 'wrong_code', 'Wrong code.',
          { attempts_left: POLICY.otpMaxAttempts - attempts });
      }

      // approved: void the seal, reopen the manifest, recall any live movement
      await c.query(`UPDATE custode.otp SET consumed_at=now() WHERE id=$1`, [otp.id]);
      const seal = (await c.query(`SELECT * FROM custode.seal WHERE id=$1`,
        [box.current_seal_id])).rows[0];
      await c.query(
        `UPDATE custode.seal SET status='VOIDED', voided_at=now(), void_reason=$1 WHERE id=$2`,
        ['unsealed under dual control', seal.id]);
      await c.query(
        `UPDATE custode.box SET status='OPEN', current_seal_id=NULL WHERE id=$1`, [box.id]);

      await append(c, {
        type: 'unseal.approved', detail: { approver_user_id: otp.approver_user_id },
        actor: req.auth.actor, box_id: box.id, store_id: box.store_id,
      });
      await append(c, {
        type: 'seal.voided', detail: { seal_no: seal.seal_no },
        actor: req.auth.actor, box_id: box.id, store_id: box.store_id,
      });

      let recalled: string | null = null;
      const mv = await draftMovement(c, box.id);
      if (mv && ['BOOKED', 'OFFERED', 'ASSIGNED'].includes(mv.status)) {
        const q = cancelQuote({ status: mv.status, booked_at: new Date(mv.booked_at) }, new Date());
        const fee = q.allowed ? q.fee_cents : 0;
        await c.query(
          `UPDATE custode.movement SET status='RECALLED', cancel_fee_cents=$1 WHERE id=$2`,
          [fee, mv.id]);
        await append(c, {
          type: 'movement.recalled', detail: { movement_ref: mv.movement_ref, fee_cents: fee },
          actor: req.auth.actor, movement_id: mv.id, box_id: box.id, store_id: box.store_id,
        });
        recalled = mv.movement_ref;
      }
      await append(c, {
        type: 'manifest.reopened', detail: { box_ref: box.box_ref, prior_seal_no: seal.seal_no },
        actor: req.auth.actor, box_id: box.id, store_id: box.store_id,
      });

      return ({
        box: { id: box.id, box_ref: box.box_ref, status: 'OPEN', seal_count: box.seal_count },
        voided_seal: seal.seal_no, recalled_movement: recalled,
      });
    });
  });

  async function isSandboxKey(c: pg.PoolClient, req: { headers: Record<string, unknown> }) {
    const key = req.headers['x-api-key'];
    if (typeof key !== 'string') return false;
    const { rows } = await c.query(`SELECT live FROM custode.api_key WHERE key_hash=$1`, [sha256Hex(key)]);
    return rows[0] ? !rows[0].live : false;
  }

  // ------------------------------------------------------------------ ledger
  app.get('/v1/ledger', { preHandler: requires('ledger.read') }, async (req, reply) => {
    // scope: store roles see their store, provider admins their provider, CUSTODE all
    const p = req.auth;
    const where: string[] = [];
    const args: unknown[] = [];
    if (p.principal.kind === 'user') {
      if (p.store_id) { args.push(p.store_id); where.push(`store_id = $${args.length}`); }
      else if (p.provider_id) { args.push(p.provider_id); where.push(`provider_id = $${args.length}`); }
    } else if (p.principal.kind === 'api_key') {
      args.push(p.provider_id); where.push(`provider_id = $${args.length}`);
    }
    const { rows } = await pool.query(
      `SELECT seq, id, movement_id, box_id, type, detail, actor_role, actor_label, at, prev_hash, hash
         FROM custode.ledger_event ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY seq DESC LIMIT 200`, args);
    const head = await pool.query(`SELECT hash FROM custode.ledger_event ORDER BY seq DESC LIMIT 1`);
    return ({ chain_head: head.rows[0]?.hash ?? null, events: rows });
  });

  app.get('/v1/ledger/verify', { preHandler: requires('ledger.verify') }, async (_req, reply) => {
    return verify(pool);
  });
}
