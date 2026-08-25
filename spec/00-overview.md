# 0. Overview, vocabulary and roles

**CUSTODE** is a chain-of-custody courier platform for high-value retail goods in Québec. A provider
packs items into a box, scans each one, seals it, and hands it to a CUSTODE driver, who delivers it
to a named person against a one-time code and a signature. Every transition is written to an
append-only hash-chained ledger.

This document set is the build specification. It is normative: where it says MUST, the implementation
has no discretion.

---

## 0.1 The attestation boundary

This is the single most important rule in the system, and every other decision follows from it.

**CUSTODE never opens a box.**

| Party | Signs for | Evidence |
|---|---|---|
| **Provider** | What is in the box | Their own scans, timestamped, attributed to a named store user, locked at seal |
| **CUSTODE** | Which sealed unit travelled, that its seal matched the manifest at pickup, that it was intact at the door, and that time and position were unbroken between | Box-reference scan, seal match, seal photos at both ends, GPS, OTP, signature |
| **Recipient** | That they received that sealed unit, with that seal number, in that state | OTP entry + signature at the door |

The manifest is **declared**, not verified. The system MUST NOT render any string claiming CUSTODE
verified box contents. Approved phrasing: *"shipper-attested contents, seal-verified custody."*

### Consequences that are load-bearing

1. **The driver is never the source of the seal number.** The seal arrives with the manifest; the
   driver confirms a match. A free-text seal field at pickup is a security defect, not a convenience.
2. **Liability splits on two bindings.** `items → box` is the provider's. `box → recipient` is ours.
   Every dispute resolves to exactly one of them.
3. **Item identifiers are polymorphic.** IMEI is one type among several. Luhn validation is selected
   by item type, never applied universally.

---

## 0.2 Vocabulary

Use these words in code, database columns, API fields, UI copy and commit messages. Do not introduce
synonyms.

| Term | Meaning |
|---|---|
| **Provider** | The company shipping goods (BMobile, Planète Mobile, Cellcom). Holds the commercial contract. |
| **Store** | A physical location belonging to a provider. Scoping boundary for users and movements. |
| **Store user** | A person at a store. Role `STORE_MANAGER` or `STORE_REP`. |
| **Recipient** | The person receiving the box. Has no account; reached by tokenised link. Never called "client" in code. |
| **Ticket** | The provider's own work-order reference. The spine linking their system to ours. |
| **Box** | One physical sealed unit. Carries a `box_ref` (`BX-####`). |
| **Seal** | A tamper-evident numbered seal (`CS-#####`) from a CUSTODE-controlled range. |
| **Manifest** | The set of item lines scanned into a box. Immutable once sealed. |
| **Manifest line** | One item: a serialized identifier, or a SKU with a quantity. |
| **Movement** | One box travelling from an origin to a recipient. Carries `movement_ref` (`M-####`). |
| **Leg** | A movement in one direction. A REPRISE is a separate movement, not a leg of the first. |
| **Custody** | The interval between `custody.accepted` and `custody.released`. |
| **Handover** | The moment custody changes hands. Requires two proofs. |
| **Two proofs** | OTP **and** signature. Both mandatory, at pickup and at delivery. No either/or mode exists. |
| **Exception** | A movement that cannot complete. Custody is retained, never improvised. |
| **Ledger** | The append-only hash-chained event log. |
| **Declared value** | Sum of the manifest lines' values, in cents CAD. Never printed on a label. |

---

## 0.3 The five platforms

| # | Platform | Users | Delivery |
|---|---|---|---|
| 1 | **Admin console** | `SUPER_ADMIN` | Web (React) |
| 2 | **Dispatch board** | `DISPATCHER`, `SUPER_ADMIN` | Web (React) |
| 3 | **Driver app** | `DRIVER` | React Native (iOS + Android) |
| 4 | **Packing desk / provider portal** | `PROVIDER_ADMIN`, `STORE_MANAGER`, `STORE_REP` | Web (React), responsive to phone |
| 5 | **Recipient tracker** | Recipient, unauthenticated + token | Web (React), mobile-first |

---

## 0.4 Roles

```ts
type Role =
  | 'SUPER_ADMIN'      // CUSTODE owner. Full ledger, all providers, all config.
  | 'DISPATCHER'       // CUSTODE ops. Live movements, reassign, exceptions. No config, no billing.
  | 'DRIVER'           // A contractor or owner-driver. Own route only.
  | 'PROVIDER_ADMIN'   // Provider HQ. All their stores, billing, API keys, claims.
  | 'STORE_MANAGER'    // One store. Packing, ledger for their own store, unseal approval.
  | 'STORE_REP';       // One store. Packing only. No ledger, ever.
```

The recipient is deliberately **not** a role. They hold a signed, expiring token bound to one
movement. Issuing recipients accounts is out of scope for v1 and MUST NOT be added without revisiting
Law 25 obligations.

---

## 0.5 Permission matrix

`○` = own scope only. `—` = denied. Enforcement is **server-side on every endpoint**. Hiding a panel
in the UI is not a permission.

| Capability | SUPER_ADMIN | DISPATCHER | DRIVER | PROVIDER_ADMIN | STORE_MANAGER | STORE_REP | Recipient |
|---|---|---|---|---|---|---|---|
| Read ledger | ✔ | ○ movement | — | ○ provider | ○ store | **—** | — |
| Chain-integrity verify | ✔ | — | — | ○ | — | — | — |
| Pack a box (scan, seal) | ✔ | — | — | — | ✔ | ✔ | — |
| Approve an unseal | ✔ | — | — | — | ✔ | **—** | — |
| Book a movement | ✔ | ✔ | — | ✔ | ✔ | ✔ | — |
| Cancel a movement | ✔ | ✔ | — | ✔ | ✔ | ○ own | — |
| Override a delivery address | ✔ | ✔ | — | ✔ | ✔ | ✔ *(reason required)* | — |
| Review address overrides | ✔ | ✔ | — | ○ | ○ | — | — |
| Accept / decline an offer | — | — | ✔ | — | — | — | — |
| Record pickup / delivery | — | — | ✔ | — | — | — | — |
| Reassign a movement in custody | ✔ | ✔ | — | — | — | — | — |
| See recipient PII | ✔ | ✔ | ○ active stop | ○ | ○ | ○ | ○ self |
| Issue / rotate API keys | ✔ | — | — | ○ | — | — | — |
| Edit rate card | ✔ | — | — | — | — | — | — |
| Manage seal ranges | ✔ | — | — | — | — | — | — |
| Driver onboarding files | ✔ | ○ read | ○ self | — | — | — | — |
| Payouts | ✔ | — | ○ self | — | — | — | — |
| Purge personal data | ✔ | — | — | — | — | — | — |
| Track a movement | ✔ | ✔ | ○ assigned | ○ | ○ | ○ | ○ token |

**Two rules that are non-negotiable:**

- `STORE_REP` MUST NOT be able to read the ledger through any endpoint, export, error message or
  webhook payload. `GET /ledger` returns `403` for that role — not an empty array.
- The `STORE_MANAGER` role is assigned by CUSTODE at provider onboarding. A provider MUST NOT be able
  to promote their own users to manager, or a rep promotes themselves and dual control collapses.

---

## 0.6 Repository layout

```
custode/
├── packages/
│   ├── core/            # shared types, enums, validators, pricing, ledger hashing
│   ├── api/             # Node + Fastify. The only thing that touches Postgres.
│   ├── web-admin/       # React. Admin console + dispatch board.
│   ├── web-provider/    # React. Packing desk + provider portal.
│   ├── web-track/       # React. Recipient tracker. No auth.
│   └── mobile-driver/   # React Native. Driver app.
├── db/
│   ├── migrations/      # numbered, forward-only SQL
│   └── seed/
├── infra/               # Bicep templates, GitHub Actions
└── spec/                # this document set
```

`packages/core` is the contract. Enums, item-type validators, pricing and the ledger hash function
live there and are imported by API, web and mobile. Duplicating a validator anywhere else is a
review-blocking defect.

---

## 0.7 Global conventions

| Concern | Rule |
|---|---|
| IDs | ULID, prefixed: `mov_`, `box_`, `seal_`, `prv_`, `str_`, `usr_`, `drv_`, `tkt_`, `evt_` |
| Public references | `M-####` movements, `BX-####` boxes, `CS-#####` seals. Displayed, never used as keys. |
| Time | `timestamptz`, always UTC, ISO 8601 with `Z`. Render in `America/Toronto`. |
| Money | Integer **cents**, CAD. Never a float. Field names end `_cents`. |
| Enums | `SCREAMING_SNAKE`, stored as Postgres text with a CHECK constraint, not native enums. |
| Language | `fr-CA` default, `en-CA` supported. Every user-facing string is keyed, none inline. |
| Errors | RFC 9457 problem+json. `type`, `title`, `status`, `detail`, `code`, plus domain fields. |
| Idempotency | Every unsafe endpoint accepts `Idempotency-Key`. Replays return the original response. |
| Pagination | Cursor-based: `?limit=&cursor=`, response `{ data, next_cursor }`. Never offset. |
| Casing | `snake_case` in JSON and SQL. `camelCase` inside TypeScript only, mapped at the boundary. |
