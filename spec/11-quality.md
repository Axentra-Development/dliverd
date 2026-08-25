# 11. Quality, testing and operations

---

## 11.1 Non-functional requirements

| Concern | Target |
|---|---|
| `POST /boxes/:id/scan` p95 | **< 250 ms** — this is the counter-speed path; everything else can be slower |
| Other API p95 | < 600 ms |
| Tracker first contentful paint on 4G | < 1.5 s |
| Availability | 99.5% business hours (07:00–21:00 ET). A packing desk that is down stops a store from shipping. |
| Ledger append | Single-writer, correctness over throughput. Hundreds/day now, thousands at scale — never a bottleneck. |
| Offline queue | 48 h of one driver's work without data loss |
| Concurrency at launch | 2 drivers, 3 stores, ~30 movements/day. Design for 40 drivers, 200 stores, 2,000/day without re-architecting. |
| Backups | Point-in-time restore, 35-day window, geo-redundant to Canada East. **Restore tested quarterly** — an untested backup is a hope. |
| RPO / RTO | 5 min / 4 h |

---

## 11.2 Invariants

These are asserted in tests and, where possible, enforced in the database. If one is ever false, the
product is not what it claims to be.

1. `ledger_event` is append-only. No `UPDATE`, no `DELETE`, ever.
2. Every event's `prev_hash` equals the previous event's `hash`, with no gaps in `seq`.
3. A `SEALED` box has no manifest mutations after `sealed_at`.
4. A voided seal is never reapplied to any box.
5. `DELIVERED` implies: OTP consumed **and** signature captured **and** both seal photos present
   **and** the handover position within the geofence (or a chained dispatcher override).
6. `PICKED_UP` → terminal only through a handover with two proofs, or an exception. There is no
   silent close.
7. No movement is `OFFERED` to a driver failing the eligibility query (§1.1).
8. `STORE_REP` receives `403` from every ledger route, with no count and no hint.
9. A material address change always has a reason and an `address_override` row.
10. `address_fetched_id` is written once and never updated.
11. `declared_cents` never appears in any label PDF, push payload, or driver API response.
12. A purged movement still verifies against the chain.

---

## 11.3 Test strategy

| Layer | Tool | Scope |
|---|---|---|
| Unit | Vitest | `core`: pricing, cutoffs, cancellation quotes, item-type validators, reconciliation, dwell prediction, canonical hashing |
| Contract | Vitest + `zod` | Every endpoint's request/response against the generated OpenAPI. A drift between code and spec fails CI. |
| Integration | Vitest + Testcontainers Postgres | Every state transition, every guard, every RLS policy, the manifest-lock trigger, the ledger triggers |
| Property | fast-check | **Chain integrity**: for any random sequence of valid operations, `verify()` returns ok. This is the single highest-value test in the repo. |
| E2E web | Playwright | The five journeys below |
| E2E mobile | Maestro | Handover happy path, geofence block, offline queue drain |
| Load | k6 | 50 concurrent packers scanning; 2,000 movements/day dispatch board |
| Security | OWASP ZAP baseline + `npm audit` + secret scanning | Every PR |

### The five journeys that must never break

1. **Pack → seal → book → deliver.** Ticket lookup, scan two items, confirm address, seal, book at
   $10.75, print label, driver picks up with seal match, delivers with code + signature inside the
   geofence, recipient receipt renders with the correct declared-by line.
2. **Discrepancy.** Scan an item not on the ticket, seal blocked, reason required, sealed with the
   discrepancy recorded, and the discrepancy appears on the receipt.
3. **Unseal.** Sealed box, unlock requested, code to the *other* user, one wrong code, correct code,
   seal voided, movement recalled, label voided, re-seal issues a different number, `seal_count = 2`
   surfaces on the receipt. Then five wrong codes locks the box.
4. **Address override.** Minor edit saves silently; material edit demands a reason; save blocked
   without one; confirmation cleared by an edit; override lands in the admin queue.
5. **Role gate.** `STORE_REP` sees no chain component, and `GET /ledger` returns `403` with no count,
   no hash, and no hint in the body.

### Label leak test

```ts
it('the label never discloses contents or value', async () => {
  const text = await pdfText(await renderLabel(movement));
  for (const forbidden of ['iPhone', 'MagSafe', 'IMEI', '1449', '1,449', '$', 'CAD'])
    expect(text).not.toContain(forbidden);
});
```

Keep this. It is exactly the kind of rule someone reverses in six months because "the driver wanted to
know what's in it."

### Fixtures

`db/seed/` provides two providers, three stores, six users across all roles, two drivers, a catalogue
of eight items spanning IMEI / SERIAL / SKU, three tickets, and one seal range. The same fixtures back
the sandbox environment, so a provider's test data and our test data are the same shape.

---

## 11.4 Observability

| Signal | Tool |
|---|---|
| Logs | Structured JSON → Azure Monitor. Every line carries `request_id`, `principal_role`, `movement_ref` where relevant. **Never** PII, OTP codes, or full addresses. |
| Traces | OpenTelemetry, sampled at 10%, 100% for any request that writes a ledger event |
| Metrics | Prometheus-format via Azure Monitor |
| Errors | Sentry, API and both clients, PII scrubbing configured before first release |
| Uptime | External check on `GET /health` and on the tracker, every minute, from outside Azure |

### Alerts that page

| Alert | Threshold |
|---|---|
| Chain verification failure | any |
| Seal reuse or out-of-range seal attempt | any |
| Mocked location during a handover | any |
| Driver SOS | any |
| OTP failure cluster | > 3 failures on one movement, or > 10 per store per hour |
| Movement unassigned past `OFFER_TIMEOUT` | any |
| Webhook endpoint degraded | any |
| Scan p95 > 400 ms | 5 min |
| Insurance or licence expiring | 30 days |
| Seal range < 100 remaining | any |

### Business dashboard

On-time %, exception rate by code, average custody duration, average dwell by building type, declared
value in transit right now, cost per delivery, material overrides this week, unseal events this week.

The last two are watched as **fraud indicators**, not as operational metrics. A store whose override
and unseal rates are out of line with its volume is the signal you are looking for.

---

## 11.5 Runbooks

Written before launch, one page each, in `docs/runbooks/`:

1. Driver phone lost or stolen mid-route
2. Vehicle breakdown with boxes in custody — the reassign path
3. Seal broken in transit
4. Recipient disputes a delivery
5. Provider reports a shortage — running the two-bindings triage
6. Chain verification failed
7. SMS provider outage — the fallback for `approaching`
8. Postgres failover
9. Law 25 access or erasure request
10. Suspected insider redirect

Runbook 5 is the one to write first and rehearse. It is the dispute that decides whether the
attestation boundary actually holds under pressure, and the answer has to be the same every time,
from either owner, without improvisation.
