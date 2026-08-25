# CUSTODE

Chain-of-custody courier platform. Node + Postgres on Azure; React web apps; React Native driver app.

The build specification is in [`spec/`](./spec) — it is normative. Where it says MUST, the
implementation has no discretion.

## The rule everything follows from

**CUSTODE never opens a box.** The provider scans items in and seals it; we attest which sealed unit
travelled, that its seal matched the manifest at pickup, that it was intact at the door, and that time
and position were unbroken between. The manifest is *declared*, not verified.

Approved phrasing: **"shipper-attested contents, seal-verified custody."** Never claim we verified
what was in the box.

Two bindings, two owners — every dispute resolves to exactly one:

| Binding | Owner | Evidence |
|---|---|---|
| items → box | **provider** | their own scans, timestamped, attributed, locked at seal |
| box → recipient | **CUSTODE** | box scan, seal match, seal photos, geofence, OTP, signature |

## Layout

```
packages/core/     shared contract — types, validators, pricing, authz, ledger hashing
db/migrations/     forward-only SQL. No down migrations: the ledger is never rolled back.
db/test/           invariant tests that assert the guards actually fire
spec/              the build specification, 13 sections
```

`packages/core` is imported by the API, the web apps and the mobile app. Duplicating a validator,
a price or an enum anywhere else is a review-blocking defect.

## Running

```bash
npm install
npm test            # 53 unit + property tests
npm run typecheck

# database (needs a running Postgres 16 and PG* env vars)
npm run test:db     # migrates a scratch DB, asserts all 24 guards
```

## What is enforced where

Guards live in the database as well as the application, because application bugs are normal and a bug
that also has to defeat a trigger is much rarer.

| Invariant | Enforced by |
|---|---|
| Ledger is append-only | `ledger_no_update` trigger + `REVOKE UPDATE, DELETE` |
| Manifest freezes at seal | `manifest_guard` trigger |
| A voided seal is never reapplied | `guard_seal_status` trigger |
| The fetched address is never rewritten | `guard_address_fetched` trigger |
| A material override always has a reason | `material_needs_reason` CHECK |
| Only SUPER_ADMIN creates a STORE_MANAGER | `guard_manager_grant` trigger |
| Serialized items are always qty 1 | `serialized_qty` CHECK |
| An unknown item carries a photo | `unknown_needs_photo` CHECK |
| STORE_REP can never read the ledger | `can()` in core, plus route guards |

## Two things that must not be deferred

1. **Salted address hashes in the ledger from migration 0001.** An immutable log holding plaintext
   addresses collides with the Law 25 right to erasure. The salt lives with the PII row, so purging
   the address also destroys the ability to brute-force it back. Retrofitting means choosing between
   a broken chain and refusing a lawful request.
2. **`dwell_seconds` and `travel_seconds` on every stop.** Free, invisible, and impossible to
   backfill. The routing model needs a season of it before it beats a plain traffic API.
