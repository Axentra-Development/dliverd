# 3. State machines and business rules

---

## 3.1 Box and seal

```
                    ┌──────────────────────────────────────────┐
                    │                                          │
  (create) ──▶ OPEN ──scan items──▶ OPEN ──seal──▶ SEALED ──pickup──▶ IN_CUSTODY
                 ▲                                   │                     │
                 │                                   │                     │ delivery
                 └────── unseal (dual control) ──────┘                     ▼
                                                                       RELEASED
```

| Transition | Guard |
|---|---|
| `OPEN → SEALED` | ticket attached · ≥1 line · address confirmed · seal in range and `ISSUED` |
| `SEALED → OPEN` | unseal approved by a second person's OTP |
| `SEALED → IN_CUSTODY` | driver scanned `box_ref` **and** the seal number matched the manifest |
| `IN_CUSTODY → RELEASED` | OTP verified + signature captured + inside geofence + both seal photos |

**Unsealing rules**

1. Requires a reason from a closed list.
2. Requires an OTP delivered to a **different** user with role `STORE_MANAGER` (or `SUPER_ADMIN`). If
   no second user is on shift, the request escalates to CUSTODE dispatch rather than self-approving.
3. On approval: seal → `VOIDED` permanently; `box.seal_count += 1`; any booked movement is `RECALLED`;
   any printed label is voided.
4. Five failed codes → the box is locked; only `SUPER_ADMIN` can open it. Chain `unseal.locked`.
5. `box_ref` never changes. It is the same physical box.
6. A re-sealed box carries `seal_count > 1` permanently, and **this appears on the recipient's
   receipt**. A box that was opened and closed again is not the same as one that never was.

---

## 3.2 Movement

```
  BOOKED ──▶ OFFERED ──accept──▶ ASSIGNED ──pickup──▶ PICKED_UP ──handover──▶ DELIVERED
     │           │                   │                    │
     │           │                   │                    ├──▶ EXCEPTION ──▶ (resolve) ──▶ DELIVERED
     │           │                   │                    │                            └─▶ REPRISE (new movement)
     └───────────┴───────────────────┴──▶ CANCELLED       └──▶ RECALLED (unseal after booking)
```

| From → To | Trigger | Guard |
|---|---|---|
| `BOOKED → OFFERED` | automatic on book | ≥1 eligible online driver |
| `OFFERED → ASSIGNED` | `POST /movements/:ref/accept` | **first accept wins**, atomic `UPDATE … WHERE status='OFFERED'` |
| `ASSIGNED → PICKED_UP` | `POST /movements/:ref/pickup` | box scan + seal match + seal photo + pickup OTP + pickup signature + inside origin geofence |
| `PICKED_UP → DELIVERED` | `POST /movements/:ref/deliver` | delivery OTP + signature + seal photo + inside destination geofence |
| any open → `CANCELLED` | `POST /movements/:ref/cancel` | not yet `PICKED_UP` |
| `PICKED_UP → EXCEPTION` | `POST /movements/:ref/exception` | reason code required |
| `EXCEPTION → DELIVERED` | retry same day | proofs as normal |
| `EXCEPTION → (REPRISE)` | dispatcher decision | creates a new movement with `parent_movement_id` |
| any → `RECALLED` | unseal approved after booking | cancellation fee applies as below |

**Custody never lapses.** There is no path from `PICKED_UP` to a terminal state that does not record
either a handover with two proofs or an exception. A driver cannot "close" a job.

---

## 3.3 Packing rules

```ts
// packages/core/rules/packing.ts
export function canSeal(box: Box, mv: MovementDraft): Result {
  if (!box.ticket_id)                return err('ticket_required');
  if (box.lines.length === 0)        return err('empty_box');
  if (!mv.address_confirmed_at)      return err('address_not_confirmed');
  if (box.declared_cents > provider.declared_cap_cents) return err('declared_cap_exceeded');
  const d = reconcile(box, ticket);
  if (d.missing || d.short || d.extra) return needsReason('discrepancy', d);
  return ok();
}
```

**Reconciliation** compares scanned lines to `ticket_expected_line`:

| Status | Meaning | Behaviour |
|---|---|---|
| `HIT` | scanned qty === expected qty | green |
| `MISSING` | expected, nothing scanned | blocks a clean seal |
| `SHORT` | scanned < expected | blocks a clean seal |
| `OVER` | scanned > expected | blocks a clean seal |
| `EXTRA` | scanned, not on ticket | blocks a clean seal, never blocks the *scan* |
| `PENDING` | scanned before a ticket was attached | resolves when the ticket attaches |

A discrepancy does not prevent sealing; it requires a reason from a closed list, and both the
discrepancy and the reason go into `box.sealed` detail and onto the recipient's receipt.

**Scan rules**

```ts
if (!catalogue.has(code))              → prompt unknown-item capture (code + description + photo)
if (serialized && alreadyOnThisBox)    → reject 409 duplicate_serialized_item
if (serialized && openMovementElsewhere) → reject 409 serialized_item_in_transit
if (!serialized && alreadyOnThisBox)   → qty += 1, no warning
if (box.status !== 'OPEN')             → reject 409 manifest_locked
```

**Never block a packing session at a busy counter.** An unrecognised barcode is captured, not refused.
Blocking is how store staff abandon the app on day three.

---

## 3.4 Address rules

```ts
const MATERIAL_FIELDS = ['line1', 'city', 'postal'] as const;
```

| Change | Requirement |
|---|---|
| `unit`, `note` (buzzer, entrance, spelling) | free, recorded as `address.corrected` |
| any of `line1`, `city`, `postal` | reason from a closed list, recorded as `address.overridden` |
| material change **and** `declared_cents > 200000` ($2,000) | additionally requires `STORE_MANAGER` approval |
| any change after `address_confirmed_at` | clears the confirmation, chains `address.unconfirmed` |
| any change after `box.status='SEALED'` | requires unseal, or dispatcher action if in custody |
| any change after `PICKED_UP` | **dispatcher only**, and the destination geofence MUST be re-pinned in the same transaction |

That last row is a real failure mode: change the address without moving the geofence and the driver
arrives at the correct door to a handover the app refuses to unlock.

`address_fetched_id` is written once, before any edit, and is never updated. Both addresses stay on
the movement forever.

---

## 3.5 Handover rules

**Two proofs, always, both directions.** There is no configuration that disables either one.

```ts
const GEOFENCE_M = 100;              // configurable per provider, default 100
const OTP_TTL_MIN = 10;
const OTP_MAX_ATTEMPTS = 5;
const OTP_LENGTH = 6;
```

| Rule | Detail |
|---|---|
| OTP destination | **Pickup**: the store user releasing the box. **Delivery**: the recipient's mobile. Never displayed to the driver. |
| OTP delivery timing | Bundled into the "driver approaching" notification, not at booking. See §8. |
| Attempts | 5, counted server-side per movement. On exhaustion → dual control: dispatcher issues a one-time override, chained. |
| Expiry | 10 minutes. Expired codes are reissued by the recipient or by dispatch, never by the driver. |
| Signature | Mandatory. Canvas capture, PNG, with `signer_name` typed by the driver and confirmed by the signer. |
| Geofence | Handover blocked beyond 100 m of the stop. **Not disableable in the UI.** |
| Geofence failure | If GPS accuracy > 100 m for 60 s, the driver may request a dispatcher override; chained as `geofence.blocked` + `admin.impersonated`-class approval. Never a silent bypass. |
| Mocked location | `mocked=true` on any ping during a handover → refuse the handover, chain `location.mocked`, alert dispatch. |
| Seal | Pickup: scanned seal MUST equal `box.current_seal.seal_no`. Mismatch → refuse custody, chain `seal.mismatch`. |
| Seal photos | `SEAL_AT_PICKUP` and `SEAL_AT_DOOR` both required before `DELIVERED`. |

**Refuse-at-pickup** is a first-class flow. A driver must be able to decline custody before it starts —
broken seal, wrong seal number, box not ready. Accepting a compromised box makes CUSTODE the last clean
signature on a bad chain.

---

## 3.6 Cancellation and recall

```ts
const FREE_CANCEL_MINUTES = 60;
const CANCEL_FEE_CENTS = 500;

export function cancelQuote(mv: Movement, now: Date) {
  if (['DELIVERED','CANCELLED','RECALLED'].includes(mv.status)) return { allowed: false };
  if (mv.status === 'PICKED_UP') return {
    allowed: false, reason: 'in_custody',
    note: 'The visit is payable in full; devices return at the REPRISE rate.' };
  return {
    allowed: true,
    fee_cents: now <= mv.free_cancel_until ? 0 : CANCEL_FEE_CENTS,
    free_until: mv.free_cancel_until,
  };
}
```

`free_cancel_until = booked_at + 60 min`, frozen at booking. A recall triggered by an unseal uses the
identical quote — breaking a seal is not a way to cancel for free after the hour.

---

## 3.7 Cutoffs and promised windows

```ts
export function availableServices(store: Store, now: Date): Service[] {
  const local = toZoned(now, store.timezone);
  const pastCutoff = local.time > store.cutoff_local;   // default 16:00
  return SERVICES.filter(s => !(s.morning_only && pastCutoff));
}
```

A service that is past cutoff is shown **disabled with the reason**, not hidden. Selling a window you
cannot serve is worse than refusing it, and hiding the option makes the refusal look like a bug.

Promised windows are computed at booking and frozen on the movement:

| Service | `promised_from` | `promised_to` |
|---|---|---|
| `CUSTODE_24_AM` | next operating day 08:00 | 10:30 |
| `CUSTODE_24_NOON` | next operating day 08:00 | 12:00 |
| `CUSTODE_24` | next operating day 08:00 | 17:00 |
| `CUSTODE_EVENING` | same or next day 17:30 | 21:00 |

---

## 3.8 Exception codes

Closed list. Free text is an additional note, never a substitute.

| Code | Meaning | Default next action |
|---|---|---|
| `RECIPIENT_ABSENT` | nobody at the door | reattempt next operating day |
| `RECIPIENT_REFUSED` | recipient declined the box | REPRISE to origin |
| `ADDRESS_INVALID` | address does not exist / unreachable | hold, dispatcher contacts store |
| `ACCESS_BLOCKED` | building, gate, no parking after reasonable effort | reattempt |
| `SEAL_COMPROMISED` | seal broken or wrong in transit | hold, escalate, photo required |
| `ID_MISMATCH` | named recipient could not be verified | hold |
| `UNSAFE` | driver judged the stop unsafe | hold, notify dispatch immediately |
| `VEHICLE` | breakdown, accident | dispatcher reassigns the whole route |
| `WEATHER` | conditions make the stop impossible | reattempt |

Every exception **retains custody**. The box stays with the driver until dispatch resolves it, or
returns to origin as a REPRISE. There is no "leave at door" and there never will be.

---

## 3.9 Dispatch and offers

- On `BOOKED`, the movement is offered to every eligible online driver (§1.1 eligibility query).
- **First accept wins**, implemented as a single conditional update. Losers get `409 already_taken`.
- A decline hides the offer for that driver only, for that movement.
- If nobody accepts within `OFFER_TIMEOUT_MIN = 15`, the movement surfaces on the dispatch board as
  unassigned and alerts.
- **Add-on insertion scoring**: before offering a mid-route booking to a driver, compute whether
  inserting it breaks an already-sold promised window on their route. If it does, do not offer it to
  that driver. Today's first-accept-wins is blind to this and a driver can silently kill a 10:30
  commitment.
- **Reassign in custody** is a dispatcher-only action requiring a reason. It creates a
  driver-to-driver handover with two proofs on both sides, or a return to origin. It is the answer to
  "the car broke down with nine boxes in it" and it is a launch requirement, not a v2 feature.
