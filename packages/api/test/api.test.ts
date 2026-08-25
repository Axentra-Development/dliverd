import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { newApiKey, sha256Hex } from '@custode/core';
import { buildApp } from '../src/app.js';

/**
 * Integration tests against a real Postgres — the migrations, the triggers,
 * the routes and the ledger, together. Spec §11.3.
 */

const DB = 'custode_api_test';
const admin = () => new pg.Pool({ database: 'postgres' });
let pool: pg.Pool;
let app: ReturnType<typeof buildApp>;

const KEYS = {
  rep: newApiKey(false),      // Amélie, STORE_REP  (sandbox key → unseal returns sandbox_code)
  mgr: newApiKey(false),      // Karim, STORE_MANAGER
  admin: newApiKey(false),    // CUSTODE super admin
};

const H = (k: string) => ({ 'x-api-key': k, 'content-type': 'application/json' });

beforeAll(async () => {
  const a = admin();
  await a.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await a.query(`CREATE DATABASE ${DB}`);
  await a.end();

  pool = new pg.Pool({ database: DB });
  const dir = join(import.meta.dirname, '../../../db/migrations');
  for (const f of readdirSync(dir).sort()) {
    await pool.query(readFileSync(join(dir, f), 'utf8'));
  }

  // fixtures
  await pool.query(`SET custode.actor_role = 'SUPER_ADMIN'`);
  await pool.query(`
    INSERT INTO custode.provider (id, name, legal_name, declared_cap_cents)
      VALUES ('prv_bm','BMobile','BMobile inc.', 1000000);
    INSERT INTO custode.store (id, provider_id, name, address_line1, address_city, address_postal, cutoff_local)
      VALUES ('str_bb','prv_bm','BMobile Beaubien','6321 rue Beaubien E','Montréal','H1M 2Y8','23:59');
  `);
  // manager insert requires SUPER_ADMIN actor context — set per session
  const c = await pool.connect();
  await c.query(`BEGIN`);
  await c.query(`SET LOCAL custode.actor_role = 'SUPER_ADMIN'`);
  await c.query(`
    INSERT INTO custode.app_user (id, role, provider_id, store_id, display_name, phone_e164) VALUES
      ('usr_rep','STORE_REP','prv_bm','str_bb','Amélie Fortin','+15145550231'),
      ('usr_mgr','STORE_MANAGER','prv_bm','str_bb','Karim Haddad','+15145550288'),
      ('usr_root','SUPER_ADMIN',NULL,NULL,'Maya','+15145550001');
  `);
  await c.query(`COMMIT`);
  c.release();

  await pool.query(
    `INSERT INTO custode.api_key (id, key_hash, label, user_id, live) VALUES
       ('key_rep',$1,'rep key','usr_rep',false),
       ('key_mgr',$2,'mgr key','usr_mgr',false),
       ('key_adm',$3,'admin key','usr_root',false)`,
    [sha256Hex(KEYS.rep), sha256Hex(KEYS.mgr), sha256Hex(KEYS.admin)]);

  await pool.query(`
    INSERT INTO custode.catalogue_item (provider_id, code, item_type, label_fr, label_en, value_cents) VALUES
      ('prv_bm','356938035643809','IMEI','iPhone 16 Pro 256 Go','iPhone 16 Pro 256GB',144900),
      ('prv_bm','194253407409','SKU','Chargeur MagSafe 25 W','MagSafe Charger 25W',5900),
      ('prv_bm','194253991755','SKU','Étui silicone · Noir','Silicone case · Black',6500);
    INSERT INTO custode.seal_range (id, prefix, first_no, last_no, store_id)
      VALUES ('rng_1','CS-',40100,40199,'str_bb');
    INSERT INTO custode.seal (id, seal_no, range_id, issued_to_store) VALUES
      ('seal_1','CS-40118','rng_1','str_bb'),
      ('seal_2','CS-40119','rng_1','str_bb');
    INSERT INTO custode.ticket (id, provider_id, store_id, external_ref, source, raw_payload) VALUES
      ('tkt_1042','prv_bm','str_bb','BM-1042','SCANNED',
       '{"recipient":{"full_name":"Geneviève Bilodeau","phone":"+15145550142","locale":"fr-CA"},
         "address":{"line1":"6321 rue Beaubien E","city":"Montréal","province":"QC","postal":"H1M 2Y8"}}');
    INSERT INTO custode.ticket_expected_line (ticket_id, code, qty) VALUES
      ('tkt_1042','356938035643809',1),
      ('tkt_1042','194253407409',1);
  `);

  app = buildApp(pool);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

const post = (url: string, key: string, body?: unknown) =>
  app.inject({ method: 'POST', url, headers: H(key), payload: body ?? {} });
const put = (url: string, key: string, body?: unknown) =>
  app.inject({ method: 'PUT', url, headers: H(key), payload: body ?? {} });
const get = (url: string, key: string) =>
  app.inject({ method: 'GET', url, headers: H(key) });

let boxId = '';
let movId = '';

describe('the packing vertical', () => {
  it('refuses an unknown api key', async () => {
    const r = await post('/v1/boxes', 'sk_test_nope');
    expect(r.statusCode).toBe(401);
  });

  it('creates a box from a ticket and drafts the movement with the fetched address', async () => {
    const r = await post('/v1/boxes', KEYS.rep, { ticket_ref: 'bm-1042' });
    expect(r.statusCode).toBe(201);
    const b = r.json();
    boxId = b.box.id;
    movId = b.movement.id;
    expect(b.box.ticket_ref).toBe('BM-1042');
    expect(b.movement.status).toBe('DRAFT');
    expect(b.movement.recipient.phone_masked).toBe('•••• 0142');
    const mv = (await pool.query(`SELECT * FROM custode.movement WHERE id=$1`, [movId])).rows[0];
    expect(mv.address_fetched_id).toBeTruthy();
    expect(mv.address_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('404s a ticket that does not exist', async () => {
    const r = await post('/v1/boxes', KEYS.rep, { ticket_ref: 'BM-9999' });
    expect(r.statusCode).toBe(404);
  });

  it('scans an IMEI and reconciles against the ticket', async () => {
    const r = await post(`/v1/boxes/${boxId}/scan`, KEYS.rep, { code: '356938035643809' });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.reconcile.missing).toBe(1); // charger still outstanding
    expect(j.reconcile.units).toBe(1);
  });

  it('refuses the same IMEI twice', async () => {
    const r = await post(`/v1/boxes/${boxId}/scan`, KEYS.rep, { code: '356938035643809' });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('duplicate_serialized_item');
  });

  it("accepts a charger's UPC without Luhn-checking it — the original defect", async () => {
    const r = await post(`/v1/boxes/${boxId}/scan`, KEYS.rep, { code: '194253407409' });
    expect(r.statusCode).toBe(200);
    expect(r.json().reconcile.clean).toBe(true);
  });

  it('increments a repeated SKU instead of refusing', async () => {
    const r = await post(`/v1/boxes/${boxId}/scan`, KEYS.rep, { code: '194253991755' });
    expect(r.statusCode).toBe(200);
    const r2 = await post(`/v1/boxes/${boxId}/scan`, KEYS.rep, { code: '194253991755' });
    expect(r2.json().line.qty).toBe(2);
    expect(r2.json().reconcile.extra).toBe(1); // not on the ticket, flagged never blocked
  });

  it('routes an unrecognised barcode to capture, never blocking', async () => {
    const r = await post(`/v1/boxes/${boxId}/scan`, KEYS.rep, { code: '0009988776655' });
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe('unknown_barcode');
    const r2 = await post(`/v1/boxes/${boxId}/scan/unknown`, KEYS.rep,
      { code: '0009988776655', description: 'Rogers SIM kit', photo_blob_id: 'blob_x' });
    expect(r2.statusCode).toBe(200);
  });

  it('blocks sealing before the address is confirmed', async () => {
    const r = await post(`/v1/boxes/${boxId}/seal`, KEYS.rep,
      { seal_no: 'CS-40118', discrepancy_reason: 'Accessory substituted with customer consent' });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('address_not_confirmed');
  });

  it('requires a reason for a material address change and records the override', async () => {
    const r0 = await put(`/v1/movements/${movId}/address`, KEYS.rep, { line1: '980 rue Fleury E' });
    expect(r0.statusCode).toBe(422);
    expect(r0.json().code).toBe('reason_required_for_material_change');

    const r1 = await put(`/v1/movements/${movId}/address`, KEYS.rep,
      { line1: '980 rue Fleury E', reason: 'Customer called to change delivery address' });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().material).toBe(true);

    const ovr = await pool.query(`SELECT * FROM custode.address_override WHERE movement_id=$1`, [movId]);
    expect(ovr.rows).toHaveLength(1);
    expect(ovr.rows[0].material).toBe(true);
  });

  it('confirming, then editing, clears the confirmation', async () => {
    await post(`/v1/movements/${movId}/address/confirm`, KEYS.rep);
    const r = await put(`/v1/movements/${movId}/address`, KEYS.rep, { note: 'Sonner deux fois' });
    expect(r.json().confirmation_cleared).toBe(true);
    const mv = (await pool.query(`SELECT address_confirmed_at FROM custode.movement WHERE id=$1`, [movId])).rows[0];
    expect(mv.address_confirmed_at).toBeNull();
  });

  it('refuses a seal from outside the controlled range', async () => {
    await post(`/v1/movements/${movId}/address/confirm`, KEYS.rep);
    const r = await post(`/v1/boxes/${boxId}/seal`, KEYS.rep, { seal_no: 'CS-99999' });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('seal_out_of_range');
  });

  it('demands a reason when the box does not match the ticket', async () => {
    const r = await post(`/v1/boxes/${boxId}/seal`, KEYS.rep, { seal_no: 'CS-40118' });
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe('discrepancy_reason_required');
    expect(r.json().reconcile.extra).toBeGreaterThan(0);
  });

  it('seals with a discrepancy reason and locks the manifest', async () => {
    const r = await post(`/v1/boxes/${boxId}/seal`, KEYS.rep,
      { seal_no: 'CS-40118', discrepancy_reason: 'Accessory substituted with customer consent' });
    expect(r.statusCode).toBe(200);
    expect(r.json().box.seal_count).toBe(1);

    const r2 = await post(`/v1/boxes/${boxId}/scan`, KEYS.rep, { code: '194253991755' });
    expect(r2.statusCode).toBe(409);
    expect(r2.json().code).toBe('manifest_locked');
  });

  it('books at the $10.75 default', async () => {
    const r = await post(`/v1/movements/${movId}/book`, KEYS.rep, {});
    expect(r.statusCode).toBe(201);
    const m = r.json().movement;
    expect(m.service_code).toBe('CUSTODE_24');
    expect(m.price_cents).toBe(1075);
    expect(m.status).toBe('OFFERED');
  });

  it('unseal demands dual control: code goes to Karim, not Amélie', async () => {
    const r = await post(`/v1/boxes/${boxId}/unseal/request`, KEYS.rep,
      { reason: 'Wrong item packed — correcting before pickup' });
    expect(r.statusCode).toBe(202);
    const j = r.json();
    expect(j.approver.display_name).toBe('Karim Haddad');
    expect(j.sandbox_code).toMatch(/^\d{6}$/);

    const bad = await post(`/v1/boxes/${boxId}/unseal/confirm`, KEYS.rep, { code: '000000' });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().attempts_left).toBe(4);

    const ok = await post(`/v1/boxes/${boxId}/unseal/confirm`, KEYS.rep, { code: j.sandbox_code });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().voided_seal).toBe('CS-40118');
    expect(ok.json().recalled_movement).toMatch(/^M-/);

    const seal = (await pool.query(`SELECT status FROM custode.seal WHERE seal_no='CS-40118'`)).rows[0];
    expect(seal.status).toBe('VOIDED');
    const mv = (await pool.query(`SELECT status FROM custode.movement WHERE id=$1`, [movId])).rows[0];
    expect(mv.status).toBe('RECALLED');
  });

  it('a voided seal can never be reused; re-seal under a new number bumps seal_count', async () => {
    const r0 = await post(`/v1/boxes/${boxId}/seal`, KEYS.rep,
      { seal_no: 'CS-40118', discrepancy_reason: 'Ticket list is wrong — box is correct' });
    expect(r0.statusCode).toBe(409);
    expect(r0.json().code).toBe('seal_voided');

    const r = await post(`/v1/boxes/${boxId}/seal`, KEYS.rep,
      { seal_no: 'CS-40119', discrepancy_reason: 'Ticket list is wrong — box is correct' });
    expect(r.statusCode).toBe(200);
    expect(r.json().box.seal_count).toBe(2);
  });

  it('STORE_REP gets a bare 403 from the ledger — no count, no hash, no hint', async () => {
    const r = await get('/v1/ledger', KEYS.rep);
    expect(r.statusCode).toBe(403);
    const body = r.body;
    expect(body).not.toMatch(/[0-9a-f]{16}/);
    expect(body).not.toMatch(/chain|event|seq|count/i);
  });

  it('STORE_MANAGER reads the chain, scoped to the store', async () => {
    const r = await get('/v1/ledger', KEYS.mgr);
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.chain_head).toMatch(/^[0-9a-f]{64}$/);
    expect(j.events.length).toBeGreaterThan(10);
    const types = j.events.map((e: { type: string }) => e.type);
    for (const t of ['box.sealed', 'unseal.approved', 'seal.voided', 'movement.recalled',
                     'address.overridden', 'address.unconfirmed'])
      expect(types).toContain(t);
  });

  it('the whole chain verifies after everything this suite did to it', async () => {
    const r = await get('/v1/ledger/verify', KEYS.admin);
    expect(r.statusCode).toBe(200);
    expect(r.json().ok).toBe(true);
    expect(r.json().count).toBeGreaterThan(20);
  });
});
