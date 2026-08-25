# 2. The ledger

The ledger is the product. Everything else is a way of producing entries for it, or reading them back.

---

## 2.1 Table

```sql
CREATE TABLE custode.ledger_event (
  seq           bigserial PRIMARY KEY,
  id            text NOT NULL UNIQUE,                  -- evt_...
  movement_id   text REFERENCES custode.movement(id),
  box_id        text REFERENCES custode.box(id),
  provider_id   text REFERENCES custode.provider(id),
  store_id      text REFERENCES custode.store(id),
  type          text NOT NULL,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id text REFERENCES custode.app_user(id),
  actor_role    text NOT NULL,
  actor_label   text NOT NULL,                         -- display name frozen at write time
  at            timestamptz NOT NULL DEFAULT now(),
  prev_hash     text NOT NULL,
  hash          text NOT NULL
);
CREATE INDEX ON custode.ledger_event (movement_id, seq);
CREATE INDEX ON custode.ledger_event (provider_id, seq);
CREATE INDEX ON custode.ledger_event (type, at DESC);

REVOKE UPDATE, DELETE ON custode.ledger_event FROM app_role;
```

The `REVOKE` is not decorative. The application database role MUST hold `INSERT` and `SELECT` only.
A migration that grants `UPDATE` on this table is a release blocker.

```sql
CREATE FUNCTION custode.ledger_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'ledger_is_append_only'; END $$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_no_update BEFORE UPDATE OR DELETE ON custode.ledger_event
  FOR EACH ROW EXECUTE FUNCTION custode.ledger_immutable();
```

---

## 2.2 Hashing

```ts
// packages/core/ledger.ts — the single implementation. Never reimplemented elsewhere.
import { createHash } from 'node:crypto';

export function canonical(o: unknown): string {
  // deterministic: keys sorted, no whitespace, no undefined, dates as ISO-8601 Z
  return JSON.stringify(o, (_k, v) =>
    v instanceof Date ? v.toISOString()
    : (v && typeof v === 'object' && !Array.isArray(v))
      ? Object.fromEntries(Object.entries(v).filter(([,x]) => x !== undefined).sort(
          ([a],[b]) => a < b ? -1 : a > b ? 1 : 0))
      : v);
}

export function eventHash(e: {
  prev_hash: string; id: string; movement_id: string | null; type: string;
  detail: unknown; actor_role: string; actor_user_id: string | null; at: Date;
}): string {
  return createHash('sha256').update(canonical(e)).digest('hex');
}
```

Full 64-hex is stored. UI may display the first 8; APIs always return the full value.

**Appending is inside the transaction that makes the change.** A movement transition and its ledger
entry commit together or not at all.

```ts
async function append(tx: Tx, input: AppendInput): Promise<LedgerEvent> {
  // serialise appends so the chain has one writer
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext('custode.ledger'))`);
  const { rows: [head] } = await tx.query(
    `SELECT hash FROM custode.ledger_event ORDER BY seq DESC LIMIT 1`);
  const prev_hash = head?.hash ?? GENESIS;
  const e = { ...input, id: ulid('evt'), prev_hash, at: new Date() };
  const hash = eventHash(e);
  await tx.query(`INSERT INTO custode.ledger_event (...) VALUES (...)`, [...]);
  return { ...e, hash };
}
```

`GENESIS = '0'.repeat(64)`.

The advisory lock makes append a single-writer operation. At CUSTODE's volume (hundreds of events per
day, thousands at scale) this is free. Do not replace it with an optimistic scheme to save microseconds
you do not need — a forked chain is unrecoverable.

---

## 2.3 Event catalogue

Every event type, its actor, and what it carries. This list is closed: adding a type is a spec change.

### Packing (actor: `STORE_REP` / `STORE_MANAGER`)

| Type | Detail |
|---|---|
| `session.opened` | `{store_id, role}` |
| `ticket.attached` | `{ticket_ref, source, expected_line_count}` |
| `ticket.detached` | `{ticket_ref}` |
| `item.scanned` | `{code, item_type, qty, expected, value_cents}` |
| `item.rejected` | `{code, reason:'duplicate_serialized'|'out_of_catalogue'|'manifest_locked'}` |
| `item.unknown_recorded` | `{code, description, photo_blob_id}` |
| `address.confirmed` | `{address_hash}` |
| `address.corrected` | `{fields, address_hash_before, address_hash_after}` |
| `address.overridden` | `{fields, reason, address_hash_before, address_hash_after, approved_by}` |
| `address.unconfirmed` | `{reason:'changed_after_confirmation'}` |
| `box.sealed` | `{box_ref, seal_no, line_count, unit_count, declared_cents, discrepancy?}` |
| `manifest.locked` | `{box_ref}` |
| `label.printed` | `{box_ref, copy_number}` |
| `label.voided` | `{box_ref, seal_no}` |

### Unsealing (dual control)

| Type | Detail |
|---|---|
| `unseal.requested` | `{seal_no, reason, requested_by}` |
| `unseal.code.sent` | `{approver_user_id, sent_to_masked, ttl_seconds}` |
| `unseal.code.failed` | `{attempt, of}` |
| `unseal.approved` | `{approver_user_id}` |
| `unseal.locked` | `{attempts}` |
| `seal.voided` | `{seal_no, reason}` |
| `manifest.reopened` | `{box_ref, prior_seal_no}` |

### Dispatch and custody (actor: `DRIVER` / `DISPATCHER` / system)

| Type | Detail |
|---|---|
| `movement.booked` | `{movement_ref, service_code, price_cents, promised_to}` |
| `movement.offered` | `{driver_count}` |
| `driver.accepted` | `{driver_id}` |
| `driver.declined` | `{driver_id}` |
| `movement.reassigned` | `{from_driver_id, to_driver_id, reason}` |
| `seal.matched` | `{seal_no, box_ref}` |
| `seal.mismatch` | `{expected_seal_no, scanned_seal_no}` |
| `custody.accepted` | `{lat, lng, accuracy_m, seal_no, photo_blob_id}` |
| `otp.issued` | `{purpose, sent_to_masked, ttl_seconds}` |
| `otp.failed` | `{purpose, attempt, of}` |
| `otp.reissued` | `{purpose}` |
| `signature.captured` | `{purpose, signer_name, lat, lng}` |
| `custody.released` | `{lat, lng, accuracy_m, seal_no, photo_blob_id}` |
| `movement.delivered` | `{movement_ref, elapsed_seconds}` |
| `movement.exception` | `{code, note, photo_blob_id}` |
| `movement.cancelled` | `{fee_cents, by_role}` |
| `movement.recalled` | `{reason, fee_cents}` |
| `geofence.blocked` | `{distance_m, required_m}` |
| `route.offroute` | `{distance_km, threshold_km}` |
| `route.resequenced` | `{from_seq, to_seq, reason, saved_seconds}` |
| `location.mocked` | `{lat, lng}` |
| `driver.sos` | `{lat, lng}` |

### Administrative (actor: `SUPER_ADMIN`)

| Type | Detail |
|---|---|
| `admin.rate_changed` | `{service_code, from_cents, to_cents}` |
| `admin.key_issued` / `admin.key_revoked` | `{key_id, provider_id, scope}` |
| `admin.user_role_changed` | `{user_id, from_role, to_role}` |
| `admin.seal_range_issued` | `{range_id, store_id, first_no, last_no}` |
| `admin.impersonated` | `{target_user_id, reason}` |
| `admin.pii_purged` | `{movement_id, fields}` |
| `admin.legal_hold` | `{movement_id, on|off, reference}` |

**Admin actions chain into the same ledger as everything else.** An administrator who can change a
rate or reissue a code without leaving a trace is the hole in the whole custody story.

---

## 2.4 Personal data and the chain

An immutable ledger containing plaintext addresses collides directly with the Law 25 right to erasure.
Resolve it structurally, not by policy:

- The ledger stores `address_hash` — `sha256(canonical_address_string || movement_salt)`.
- Plaintext lives in `pii.address`, referenced by id, purgeable.
- `movement_salt` is a per-movement random value stored **with the PII row**, so purging the PII also
  destroys the ability to brute-force the hash back from a candidate address. Without the salt, a
  postal-code-sized search space makes an unsalted hash reversible in seconds.

```ts
address_hash = sha256(`${unit}|${line1}|${city}|${province}|${postal}`.toUpperCase() + salt)
```

After purge, the chain still proves the address was never altered between confirmation and delivery —
because both entries carry the same hash — while the address itself is gone. Nothing in §2.1 changes.

The same treatment applies to `recipient_name_hash` on `signature.captured`.

Retrofitting this after a year of movements means choosing between a broken chain and refusing a
lawful deletion request. Build it in migration 0001.

---

## 2.5 Daily root

```sql
CREATE TABLE custode.ledger_root (
  service_date  date PRIMARY KEY,
  first_seq     bigint NOT NULL,
  last_seq      bigint NOT NULL,
  merkle_root   text NOT NULL,
  event_count   integer NOT NULL,
  published_at  timestamptz NOT NULL DEFAULT now(),
  external_ref  text                                   -- e.g. an RFC 3161 timestamp token
);
```

At 00:05 America/Toronto a job builds a Merkle tree over the previous day's event hashes (SHA-256,
duplicate the last leaf on odd counts) and stores the root. Publish it somewhere you do not control —
an RFC 3161 timestamp authority is the cheapest credible option.

This turns "our log is append-only" into "here is yesterday's root, timestamped by a third party before
today's events existed." That sentence is what an insurer and a court respond to.

---

## 2.6 Integrity verification

`GET /ledger/verify` recomputes the chain and returns the first break, if any.

```ts
async function verify(from = 0): Promise<VerifyResult> {
  let prev = from === 0 ? GENESIS : await hashAt(from - 1);
  for await (const e of streamEvents(from)) {
    if (e.prev_hash !== prev) return { ok: false, break_at: e.seq, reason: 'prev_mismatch' };
    if (eventHash(e) !== e.hash) return { ok: false, break_at: e.seq, reason: 'hash_mismatch' };
    prev = e.hash;
  }
  return { ok: true, verified_to: prev };
}
```

Runs nightly across the full chain and alerts on any break. The admin console exposes it as one
button — raw JSON is not evidence; a recomputation that names the first broken link is.

---

## 2.7 Export bundle

`POST /movements/:ref/export` produces a zip for an auditor, an insurer or a court:

```
M-4473/
├── custody-report.pdf      # human-readable timeline, FR and EN
├── events.json             # every ledger event for this movement, full hashes
├── chain-proof.json        # prev/next anchor hashes + the daily roots that cover them
├── manifest.json           # declared lines, marked "declared by <provider>, not verified by CUSTODE"
├── photos/                 # seal at pickup, seal at door, package, exceptions
├── signatures/             # PNG + capture metadata
└── README.txt              # what CUSTODE attests to and what it does not (§0.1, verbatim)
```

That README is not a nicety. A bundle that lets a reader assume CUSTODE counted the phones is worse
than no bundle.
