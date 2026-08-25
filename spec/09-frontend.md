# 9. Web front ends

React 18 · TypeScript · Vite · TanStack Query for server state · Zustand for the little local state
that exists · React Router. No component library — the design system below is small enough to own,
and owning it is cheaper than fighting one.

---

## 9.1 Design system

```css
:root{
  --paper:#F3F6F4; --card:#FFF; --sunk:#EAEFEC;
  --ink:#111917; --body:#2C3A36; --muted:#5B6B66; --faint:#8A9994;
  --line:#D4DDD9; --hair:#E3EAE7;
  --vir:#0F6455;  --vir-soft:#E2EFEB;      /* viridian — the brand */
  --risk:#93301F; --risk-soft:#F7E7E3;
  --warn:#7C5A0E; --warn-soft:#F8EFD8;
  --ok:#1E6B45;   --ok-soft:#E1F0E7;
}
@media (prefers-color-scheme:dark){ :root{
  --paper:#0C1211; --card:#131B19; --sunk:#0F1716;
  --ink:#EAF1EE; --body:#C2CFCB; --muted:#8DA09B; --faint:#6B7C78;
  --line:#25332F; --hair:#1D2825;
  --vir:#54C1A6; --vir-soft:#12302A;
  --risk:#E08E7A; --risk-soft:#331913;
  --warn:#D9B45E; --warn-soft:#2E2510;
  --ok:#6DC095;  --ok-soft:#12291E;
}}
```

The seal mark — a filled square beside a hollow square — is the only logo. Custody: one closed, one
open.

**Shared primitives** (`packages/core/ui`): `Card`, `Pill`, `Note`, `KV`, `Btn`, `StepNumber`,
`Toast`, `Modal`, `Table`, `EmptyState`, `ScanInput`, `SignaturePad`, `SealMark`.

Status colour is fixed and used nowhere decoratively:

| State | Token |
|---|---|
| done, delivered, matched | `--ok` |
| in progress, sealed, booked | `--vir` |
| needs attention, discrepancy, unconfirmed | `--warn` |
| refused, mismatch, override, exception | `--risk` |

---

## 9.2 Packing desk (`web-provider`)

The most important screen in the system, because it is where the evidence is created and it is used
by people with a queue behind them.

**Layout** — responsive across phone, tablet and desktop from one build. Two columns above 900 px
(steps left, box panel right, sticky); one column below.

**Header** — store, user name, **role pill**, and a Camera / Wedge scanner-mode toggle. Wedge mode
renders a focused input that a USB counter scanner types into.

### Steps

| # | Step | Contents |
|---|---|---|
| 1 | **Ticket & customer** | Scan or type the work-order ref. On success: name, masked phone, masked email, **language chip**. A copy line explains that this fetch is what unlocks the recipient's tracking link, code and receipt. |
| 2 | **Products in the box** | Live reconciliation list. Each line: tick state, label, code + item type, `got / want`, unit value. Discrepancy notes below. |
| 3 | **Where it goes** | Address as fetched (struck through if changed), address as shipping, delivery note, confirmation state, **Confirm this address** + **Edit**. |
| 4 | **Seal & label** | Disabled until step 3 is confirmed, with the reason shown. After sealing: box ref, seal no, lock state, re-seal history, **Unlock this box**. |
| 5 | **Confirm pickup** | Service select defaulting to `CUSTODE_24`, cutoff-disabled options shown with reasons, then **Print label** / **Reprint label** and **Pack another box**. |

### Behaviours that are requirements, not polish

- **Ticket-first is preferred and the UI says so**, but pack-first is fully supported. When a ticket is
  attached after scanning, run the match immediately and show a banner: *"Match run at attach — 2
  matched, 0 missing, 1 unexpected."*
- **Scanning must feel instant.** Optimistic local update, reconcile from the server response. A scan
  that waits on a round trip loses the counter.
- **Never block a scan.** Unknown barcode opens a capture modal (code + description + photo), it does
  not refuse.
- Duplicate serialized → refuse with a clear toast. Duplicate SKU → increment quantity **silently**.
- **Address modal**: minor fields free; a material change reveals a required reason select and blocks
  save until chosen; saving after a prior confirmation clears it and says so.
- **Unseal modal**: two stages in one dialog — reason, then code. Stage one lists exactly what
  breaking the seal costs (seal voided, movement recalled with the live cancellation quote, label
  voided). Stage two shows attempts remaining. Five failures closes the dialog and locks the box.
- **The custody chain component is not rendered at all for `STORE_REP`.** Not hidden with CSS, not a
  placeholder — absent from the tree.
- Every destructive or recorded action states its consequence *before* the button, never after.

---

## 9.3 Dispatch board (`web-admin`)

Single screen, three regions, designed to be watched rather than read.

| Region | Contents |
|---|---|
| **Map** | Drivers as live markers with heading and last-ping age; stops coloured by risk. Mocked-location drivers flash red. |
| **Movement rail** | Grouped `AT RISK` → `LATE` → `IN CUSTODY` → `OFFERED (unassigned)` → `ON TIME`. Each row: ref, ticket, driver, promised window, ETA, drift. |
| **Alert inbox** | SOS · mocked location · seal mismatch · off-route · OTP exhausted · SLA breach · unassigned past `OFFER_TIMEOUT`. |

Actions on a movement, all requiring a reason and all chained: **Reassign** (including in custody),
**Hold**, **Return to origin (REPRISE)**, **Reissue code**, **Override code** (after five failures),
**Change destination** (re-pins the geofence in the same transaction).

Design notes:
- Sort by *time to breach*, not by creation. The board's job is to answer "what breaks next."
- Every alert row states the action, not just the fact: "M-4473 — 12 min drift, will miss 10:30.
  Reassign or notify?"
- SOS takes over the screen. It is not a row in a list.

---

## 9.4 Admin console (`web-admin`)

| Section | Contents |
|---|---|
| **Ledger** | Filterable event stream, full hashes, chain head, and a **Verify chain** button that recomputes and names the first break. Daily Merkle roots with their external timestamps. |
| **Overrides** | The material-address-override queue. Small, high signal — where redirect fraud shows up first. |
| **Anomalies** | OTP failure clusters, seal reuse or out-of-range attempts, mocked GPS, repeat exceptions by driver or store, scan-to-seal gaps, unusual reprint counts. |
| **Providers** | Accounts, stores, users, API keys (issue / rotate / revoke), declared caps, insurance expiry. |
| **Drivers** | Onboarding file with document expiries, SOP signature, background check. Expiry warnings at 30 days. This screen *is* the underwriter's file. |
| **Rate card** | Edit services and prices. Chained. No deploy. |
| **Seal ranges** | Issue ranges to stores, see consumption, alert on exhaustion. |
| **Payouts** | Driver settlement, contractor invoices, weekly statements. |
| **Privacy** | Purge requests, legal holds, breach register, retention job status. |

---

## 9.5 Recipient tracker (`web-track`)

Mobile-first, no login, no app install, opens from an SMS link. The largest white space found in the
market — only two vendors surveyed even market a customer-facing audit trail, and neither is
cryptographic.

**States**

| State | Screen |
|---|---|
| Booked | Provider name, service window, "we'll text you when the driver is close", privacy notice |
| Assigned | Narrowed window, driver first name and vehicle |
| Approaching | Live map, "arriving in about 8 minutes", **the code, large and selectable**, and *"check the seal is intact before you sign"* |
| Delivered | Signed-by, time, **receipt** |
| Exception | Plain-words reason, what happens next, reschedule action |

**Pre-dispatch actions**: reschedule, add delivery instructions, authorise an alternate recipient
(who receives their own code — custody stays intact and named).

**The receipt** is the signature artifact of the whole product:

```
CUSTODE — Delivery receipt              M-4473
Box BX-1042 · Seal CS-40118
⚠ This box was opened and re-sealed once before dispatch.

Declared contents (declared by BMobile — not verified by CUSTODE)
  1 × iPhone 16 Pro 256 Go
  1 × Chargeur MagSafe 25 W

Custody
  09:12  Box sealed at BMobile Beaubien
  09:41  Custody accepted — seal CS-40118 photographed intact
  10:04  Delivered — code verified, signed by G. Bilodeau
         45.5501, -73.5721 · within 12 m

Chain  evt 9f2c… → 07a7… → 944e…    Verify: custode.ca/v/M-4473
```

That "declared by the shipper — not verified by CUSTODE" line is mandatory. A receipt that lets a
reader assume CUSTODE counted the phones is worse than no receipt.

**Report an issue** is available for 24 hours after delivery — box open, wrong item, missing item,
damage — and opens a claim tagged with the `binding` from §0.1.

---

## 9.6 Front-end conventions

| Concern | Rule |
|---|---|
| Server state | TanStack Query only. No hand-rolled fetch-in-`useEffect`. |
| Mutations | Optimistic where the server can't reject (scan increment); pessimistic where it can (seal, confirm, verify). |
| Polling | Dispatch board 5 s, tracker 20 s, packing desk none — it is driven by user action. Prefer SSE on the board once the volume justifies it. |
| Forms | Uncontrolled inputs, validated with the same `zod` schemas the API uses, imported from `core`. |
| Money | Rendered from cents via `Intl.NumberFormat`. A float in the front end is a bug. |
| Errors | Every mutation surfaces the server's `detail`. Never "Something went wrong." |
| Empty states | Every list has one, and it says what to do next. |
| Loading | Skeletons for lists, inline spinners for buttons. Never a full-page spinner after first paint. |
| Tests | Vitest for logic; Playwright for the five critical journeys (§11.3). |
