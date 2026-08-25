import type pg from 'pg';
import { eventHash, GENESIS, newId, verifyChain, type LedgerEvent } from '@custode/core';

/**
 * The ledger writer (spec §2.2).
 *
 * Appending happens INSIDE the transaction that makes the state change — a
 * movement transition and its ledger entry commit together or not at all.
 * The advisory lock makes append single-writer; at CUSTODE's volume this is
 * free, and a forked chain is unrecoverable.
 */

export interface AppendInput {
  type: string;
  detail: Record<string, unknown>;
  actor: { user_id: string | null; role: string; label: string };
  movement_id?: string | null;
  box_id?: string | null;
  provider_id?: string | null;
  store_id?: string | null;
}

export async function append(c: pg.PoolClient, input: AppendInput): Promise<LedgerEvent> {
  await c.query(`SELECT pg_advisory_xact_lock(hashtext('custode.ledger'))`);
  const { rows } = await c.query<{ hash: string }>(
    `SELECT hash FROM custode.ledger_event ORDER BY seq DESC LIMIT 1`,
  );
  const prev_hash = rows[0]?.hash ?? GENESIS;

  const e = {
    id: newId('evt'),
    type: input.type,
    detail: input.detail,
    actor_role: input.actor.role,
    actor_user_id: input.actor.user_id,
    movement_id: input.movement_id ?? null,
    box_id: input.box_id ?? null,
    at: new Date(),
    prev_hash,
  };
  const hash = eventHash(e);

  await c.query(
    `INSERT INTO custode.ledger_event
       (id, movement_id, box_id, provider_id, store_id, type, detail,
        actor_user_id, actor_role, actor_label, at, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [e.id, e.movement_id, e.box_id, input.provider_id ?? null, input.store_id ?? null,
     e.type, JSON.stringify(e.detail), e.actor_user_id, e.actor_role, input.actor.label,
     e.at, e.prev_hash, hash],
  );
  return { ...e, hash };
}

/** Stream the chain and recompute it. Names the first broken link (§2.6). */
export async function verify(q: pg.Pool | pg.PoolClient) {
  const { rows } = await q.query(
    `SELECT seq, id, movement_id, box_id, type, detail, actor_role, actor_user_id,
            at, prev_hash, hash
       FROM custode.ledger_event ORDER BY seq`,
  );
  // seq is 1-based bigserial; re-key to a dense 0-based index for gap detection
  const events: LedgerEvent[] = rows.map((r, i) => ({
    seq: i,
    id: r.id,
    movement_id: r.movement_id,
    box_id: r.box_id,
    type: r.type,
    detail: r.detail,
    actor_role: r.actor_role,
    actor_user_id: r.actor_user_id,
    at: new Date(r.at),
    prev_hash: r.prev_hash,
    hash: r.hash,
  }));
  return verifyChain(events);
}
