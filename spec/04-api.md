# 4. HTTP API

Node 20 · Fastify 4 · TypeScript · `zod` for every request and response schema · OpenAPI 3.1 generated
from those schemas, never hand-written.

Base: `https://api.custode.ca/v1`

---

## 4.1 Conventions

**Auth** — two mechanisms, never mixed:

| Caller | Mechanism |
|---|---|
| Human (web, mobile) | `Authorization: Bearer <JWT>` — 15 min access token, 30 day refresh, rotating |
| Machine (provider CRM) | `x-api-key: <key>` — hashed at rest, scoped to a provider, rotatable |
| Recipient | `?t=<signed token>` — bound to one movement, expires 14 days after delivery |

**Every endpoint enforces the §0.5 matrix server-side.** The route handler receives a resolved
`Principal`; a handler that does not consult it fails review.

```ts
type Principal =
  | { kind:'user'; user_id:string; role:Role; provider_id?:string; store_id?:string }
  | { kind:'api_key'; key_id:string; provider_id:string; scopes:Scope[] }
  | { kind:'recipient'; movement_id:string };
```

**Errors** — RFC 9457:

```json
{ "type":"https://api.custode.ca/errors/duplicate_serialized_item",
  "title":"Item already scanned",
  "status":409, "code":"duplicate_serialized_item",
  "detail":"IMEI 356938035643809 is already on box BX-1042.",
  "item":{ "code":"356938035643809","item_type":"IMEI","box_ref":"BX-1042" } }
```

Never leak PII or ledger content in an error body to a principal not entitled to it. A `STORE_REP`
receiving `403` on the ledger MUST NOT receive a count, a hash, or a hint.

**Idempotency** — `Idempotency-Key` accepted on every `POST`. Keys stored 24 h with the response body;
a replay returns the stored response with `Idempotency-Replayed: true`.

---

## 4.2 Auth

```http
POST /auth/request-code
  { "identifier": "514-555-0231" }        # phone_e164 or work email
  → 202 { "sent_to":"•••• 0231", "ttl_seconds":600 }
```
Always returns `202`, whether or not the identifier exists. Rate limited to 3/identifier/15 min and
10/IP/15 min.

```http
POST /auth/verify-code
  { "identifier":"514-555-0231", "code":"246810", "device_id":"..." }
  → 200 { "access_token","refresh_token","expires_in":900, "user":{ id, role, display_name, locale, store_id? } }

POST /auth/refresh      { "refresh_token" } → 200 { access_token, refresh_token }
POST /auth/logout       → 204
GET  /auth/whoami       → 200 Principal
```

Refresh tokens rotate on every use; reuse of a consumed refresh token revokes the whole family and
alerts. Driver tokens are additionally bound to `device_id`.

---

## 4.3 Packing

```http
POST /boxes                                  # STORE_REP, STORE_MANAGER
  { "store_id":"str_...", "ticket_ref":"BM-1042" }   # ticket_ref optional (pack-first)
  → 201 { box }
```

```http
GET  /tickets/lookup?ref=BM-1042             # resolves through the §5 ladder
  → 200 { ticket:{ external_ref, source, fetched_at },
          recipient:{ full_name, phone_masked, email_masked, locale },
          address:{ unit, line1, city, province, postal, note },
          expected:[ { code, item_type, label, qty, value_cents } ] }
  → 404 ticket_not_found
```

```http
POST /boxes/:id/scan                         # the hot path — must feel instant
  { "code":"356938035643809" }
  → 200 { line:{...}, reconcile:{ hit, missing, short, over, extra, units, declared_cents } }
  → 409 duplicate_serialized_item | serialized_item_in_transit | manifest_locked
  → 422 unknown_barcode        { "code":"...", "next":"POST /boxes/:id/scan/unknown" }
```

```http
POST /boxes/:id/scan/unknown
  { "code":"0009988776655", "description":"Rogers SIM kit", "photo_blob_id":"blob_..." }
  → 200 { line }                             # item_type UNKNOWN, value_cents 0

DELETE /boxes/:id/lines/:line_id             # only while OPEN
  → 204
```

```http
POST /boxes/:id/ticket                       # attach after packing (pack-first path)
  { "ticket_ref":"BM-1042" }
  → 200 { box, reconcile, match_note:"3 matched, 0 missing, 1 unexpected" }
```

```http
PUT  /movements/:id/address                  # draft movement, before seal
  { "unit":"", "line1":"980 rue Fleury E", "city":"Montréal", "postal":"H2C 1P4",
    "note":"", "reason":"Customer called to change delivery address" }
  → 200 { address, override:{ material:true, fields:["line1","postal"], reason, changed_by } }
  → 422 reason_required_for_material_change
  → 403 manager_approval_required            # material + declared > $2,000

POST /movements/:id/address/confirm          # the affirmative act
  → 200 { confirmed_by, confirmed_at }
```

```http
POST /boxes/:id/seal
  { "seal_no":"CS-40118", "discrepancy_reason":"Item back-ordered — shipping partial" }
  → 200 { box:{ status:'SEALED', seal_count }, seal }
  → 409 address_not_confirmed | empty_box | ticket_required | manifest_locked
  → 409 seal_out_of_range | seal_already_used | seal_voided
  → 422 discrepancy_reason_required
```

### Unsealing

```http
POST /boxes/:id/unseal/request
  { "reason":"Wrong item packed — correcting before pickup" }
  → 202 { approver:{ display_name, role, sent_to_masked }, ttl_seconds:600, attempts_allowed:5 }
  → 409 unseal_locked

POST /boxes/:id/unseal/confirm
  { "code":"481902" }
  → 200 { box:{ status:'OPEN', seal_count }, voided_seal:"CS-40118",
          recalled_movement:"M-4473", cancel_fee_cents:0, label_voided:true }
  → 401 { "code":"wrong_code", "attempts_left":3 }
  → 423 unseal_locked                        # 5 failures; SUPER_ADMIN only from here
```

The approver is resolved server-side as *a `STORE_MANAGER` at the same store who is not the
requester*. If none exists, the request escalates to CUSTODE dispatch. The client never chooses the
approver.

---

## 4.4 Booking

```http
POST /movements                              # from a sealed box
  { "box_id":"box_...", "service_code":"CUSTODE_24" }
  → 201 { movement:{ movement_ref, status:'OFFERED', price_cents, promised_from, promised_to,
                     free_cancel_until } }
  → 409 box_not_sealed
  → 422 service_past_cutoff  { "available":["CUSTODE_24","CUSTODE_EVENING"] }

GET  /services?store_id=str_...&at=2026-08-25T20:10:00Z
  → 200 [ { code, name, window_label, price_cents, available, unavailable_reason? } ]
```

`CUSTODE_24` is `sort_order` 1 and is the default selection in every client.

```http
POST /manifests                              # provider CRM one-shot: create + pack + seal + book
  { "store_ref":"beaubien", "ticket_ref":"BM-1042", "service":"CUSTODE_24",
    "seal_no":"CS-40118",
    "recipient":{ "full_name":"...","phone":"+15145550142","email":"...","locale":"fr-CA" },
    "address":{ "line1":"...","city":"...","postal":"..." },
    "items":[ { "code":"356938035643809","item_type":"IMEI","value_cents":144900 },
              { "code":"194253407409","item_type":"SKU","qty":1,"value_cents":5900 } ] }
  → 201 { movement }
  → 422 { "code":"item_validation_failed", "items":[ { code, item_type, reason:"luhn_failed" } ] }
```

This is the machine equivalent of the packing desk, for providers on the API rung. Validation is
**per item type** — a `SKU` is never Luhn-checked. Idempotent on `(provider_id, ticket_ref)`.

```http
GET  /movements?status=&store_id=&from=&to=&limit=&cursor=
  → 200 { data:[ MovementSummary ], next_cursor }

GET  /movements/:ref
  → 200 { movement, box, manifest_declared, events?:[...] }   # events only if entitled

POST /movements/:ref/cancel
  { "reason":"..." } → 200 { fee_cents, free_until }
  → 409 in_custody
```

---

## 4.5 Driver

```http
POST /driver/status          { "online":true } → 200 { online, eligible, blocking?:["insurance_expired"] }

GET  /driver/route?date=2026-08-25
  → 200 { route:{ id, status }, stops:[ { seq, kind, movement_ref, eta,
            place:{ name, address, lat, lng }, provider, box_ref, pay_cents,
            recipient_first_name } ] }
```

The driver receives the recipient's **first name and address only** — never the manifest, never the
declared value. A driver who knows a box holds $9,000 is a driver carrying a different kind of risk.

```http
POST /driver/route/:id/accept      → 200
GET  /driver/offers                → 200 [ Offer ]          # add-ons, insertion-scored
POST /movements/:ref/accept        → 200 | 409 already_taken | 409 breaks_promised_window
POST /movements/:ref/decline       → 204

POST /driver/ping                                            # batched, offline-queued
  { "pings":[ { at, lat, lng, accuracy_m, speed_mps, mocked, battery_pct } ] }
  → 202 { accepted, offroute?:{ distance_km, threshold_km } }
```

### Pickup

```http
POST /movements/:ref/pickup/scan-box   { "box_ref":"BX-1042" } → 200 { expects_seal:"CS-40118" }
POST /movements/:ref/pickup/scan-seal  { "seal_no":"CS-40118" }
  → 200 { matched:true } | 409 seal_mismatch { expected_masked } | 409 seal_voided
POST /movements/:ref/pickup/photo      { "kind":"SEAL_AT_PICKUP", "blob_id":"..." } → 201
POST /movements/:ref/pickup/verify     { "code":"902314" } → 200 | 401 { attempts_left }
POST /movements/:ref/pickup/signature  { "signer_name":"Amélie Fortin","blob_id":"...",
                                         "lat","lng","accuracy_m" }
  → 200 { movement:{ status:'PICKED_UP' } }
  → 409 outside_geofence { distance_m, required_m }
  → 409 location_mocked
POST /movements/:ref/pickup/refuse     { "code":"SEAL_COMPROMISED", "note", "photo_blob_id" } → 200
```

### Delivery — identical shape, `deliver` instead of `pickup`

```http
POST /movements/:ref/deliver/scan-box
POST /movements/:ref/deliver/photo         # SEAL_AT_DOOR required
POST /movements/:ref/deliver/verify        # recipient's code
POST /movements/:ref/deliver/signature     # → DELIVERED
POST /movements/:ref/exception  { "code":"RECIPIENT_ABSENT", "note", "photo_blob_id" } → 200
POST /driver/sos                { "lat","lng" } → 202
```

The step endpoints are deliberately granular: each one is individually idempotent and individually
queueable offline. A single fat `POST /deliver` cannot be replayed safely from a phone that lost
signal mid-handover.

```http
GET  /driver/earnings?from=&to=
  → 200 { total_cents, stops:[ { movement_ref, date, service, pay_cents, waiting_cents } ],
          statement_pdf_url }
```

---

## 4.6 Dispatch

```http
GET  /dispatch/board
  → 200 { movements:[ { ref, status, driver, promised_to, eta, risk:'ON_TIME'|'AT_RISK'|'LATE' } ],
          drivers:[ { id, name, online, lat, lng, last_ping_at, stops_remaining } ],
          alerts:[ { kind, movement_ref?, driver_id?, at } ] }

POST /movements/:ref/reassign     { "to_driver_id", "reason" } → 200
POST /movements/:ref/hold         { "reason" } → 200
POST /movements/:ref/return       { "reason" } → 201 { reprise_movement_ref }
POST /movements/:ref/otp/reissue  { "purpose":"DELIVERY" } → 200 { sent_to_masked, ttl_seconds }
POST /movements/:ref/otp/override { "reason" } → 200          # after 5 failures, chained
PUT  /movements/:ref/destination  { address, reason } → 200 { geofence_repinned:true }
GET  /dispatch/alerts?kind=OFFROUTE|SOS|MOCKED|SLA|OVERRIDE
```

---

## 4.7 Recipient (token, no account)

```http
GET  /track/:token
  → 200 { movement_ref, status, provider_name, service_window,
          eta:{ from, to, confidence },
          driver:{ first_name, vehicle_desc } | null,
          box:{ box_ref, seal_no, seal_count },
          declared_contents:[ { label, qty } ],
          declared_by:"BMobile — declared by the shipper, not verified by CUSTODE",
          locale }

POST /track/:token/reschedule   { "date" }                → 200   # before ASSIGNED
POST /track/:token/instructions { "note" }                → 200   # before PICKED_UP
POST /track/:token/alternate    { "full_name","phone" }   → 200   # issues their own code
POST /track/:token/issue        { "kind":"BOX_OPEN"|"WRONG_ITEM"|"MISSING_ITEM"|"DAMAGE", "note" }
  → 201 { claim_ref }                                             # within 24 h of delivery
GET  /track/:token/receipt.pdf  → 200 application/pdf
```

`seal_count > 1` MUST be surfaced in the tracker and on the receipt as *"this box was opened and
re-sealed before dispatch"*. The recipient is entitled to know which kind of box they are signing for.

---

## 4.8 Provider portal

```http
GET  /provider/movements?...              GET /provider/stats?from=&to=
POST /provider/webhooks   { "urls":[...] }
POST /provider/keys       { "label":"POS integration" } → 201 { key_id, secret }   # shown once
DELETE /provider/keys/:id
GET  /provider/invoices                   GET /provider/certificate-of-insurance.pdf
POST /provider/claims     { "movement_ref","kind","amount_cents","narrative" } → 201
GET  /provider/sandbox/keys                                # test keys, isolated data
POST /provider/sandbox/replay { "event_type","movement_ref" }
```

---

## 4.9 Admin

```http
GET  /ledger?movement_ref=&provider_id=&from=&to=&limit=&cursor=
  → 200 { chain_head, events:[ LedgerEvent ], next_cursor }
  → 403 for STORE_REP — always, with no count and no hint

GET  /ledger/verify?from=          → 200 { ok, verified_to } | { ok:false, break_at, reason }
GET  /ledger/roots?from=&to=       → 200 [ { service_date, merkle_root, external_ref } ]
POST /movements/:ref/export        → 202 { export_id }   → GET /exports/:id → zip

GET  /admin/overrides?material=true             # the review queue
GET  /admin/anomalies                           # OTP clusters, seal reuse, mocked GPS, scan patterns
PUT  /admin/services/:code    { price_cents }   # chained as admin.rate_changed
POST /admin/seal-ranges       { store_id, prefix, first_no, last_no }
GET  /admin/drivers/:id/file                    # onboarding documents + expiries
POST /admin/pii/purge         { movement_id }   # chained as admin.pii_purged
POST /admin/legal-hold        { movement_id, on }
POST /admin/impersonate       { user_id, reason } → 200 { access_token }   # always chained
```

---

## 4.10 Rate limits

| Endpoint class | Limit |
|---|---|
| `POST /auth/request-code` | 3 / identifier / 15 min · 10 / IP / 15 min |
| `POST /*/verify` (any OTP) | 5 / movement (business rule) · 20 / IP / hour |
| `POST /boxes/:id/scan` | 600 / user / hour — packing is bursty, do not throttle the counter |
| `POST /driver/ping` | 120 / driver / hour, batched |
| `GET /track/:token` | 60 / token / hour |
| Provider API key | 1,000 / hour default, raisable per contract |
