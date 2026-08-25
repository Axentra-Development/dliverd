# 5. Integration — webhooks, the ticket spine, the CRM ladder

---

## 5.1 The ticket is the spine

One binding, made once at packing, that every other reference hangs off:

```
their ticket  BM-1042
      └─▶ movement  M-4473
             └─▶ box  BX-1042
                    └─▶ seal  CS-40118
```

Consequences:

- Provider staff search by `BM-1042`. **Never make someone learn your reference number.** Every
  provider-facing lookup accepts their ref as a first-class key.
- Every webhook carries `ticket_ref`, so events land on the right CRM record with no mapping table on
  their side.
- Claims, support and invoice lines are all expressed in their vocabulary.

---

## 5.2 The integration ladder

"Link to their CRM" is not one integration. BMobile, Planète Mobile and Cellcom are not on the same
system, and per-provider API work is what consumes a small company's entire development budget.
**The product must work at every rung, and week one runs on the bottom two.**

| Rung | `ticket.source` | What it takes | When |
|---|---|---|---|
| 1 · Live API | `API` | Their CRM exposes an endpoint and issues credentials. Best experience, slowest to obtain, separate negotiation per provider. | Month 2+ |
| 2 · File drop | `FILE_DROP` | SFTP or blob container, periodic CSV/JSON of open tickets. Often approved *faster* than API access — read-only and asynchronous. | Month 1–2 |
| 3 · **Scan the printed work order** | `SCANNED` | Most POS and dealer systems already print the ticket number as a barcode. Links the ticket with **zero integration**, using the scanner already in their hand. | **Week 1** |
| 4 · Type it | `MANUAL` | Always available, never removed. | Week 1 |

Rung 3 is the one people skip and it is the whole week-one answer. `GET /tickets/lookup` resolves
downward automatically: try the live adapter, fall back to the last file drop, fall back to a bare
reference with no expected lines (which still binds the spine and still lets reconciliation run as
`PENDING`).

```ts
async function lookupTicket(provider: Provider, ref: string): Promise<TicketResolution> {
  for (const rung of provider.adapters) {              // ordered, best first
    const r = await rung.fetch(ref).catch(() => null);
    if (r) return { ...r, source: rung.source };
  }
  return { external_ref: ref, source: 'MANUAL', expected: [], recipient: null, address: null };
}
```

**A failed CRM lookup MUST NOT block packing.** It degrades to manual entry of recipient and address.

### Adapter contract

```ts
interface TicketAdapter {
  source: 'API' | 'FILE_DROP';
  fetch(ref: string): Promise<{
    external_ref: string;
    recipient: { full_name: string; phone_e164?: string; email?: string; locale?: Locale };
    address: { unit?: string; line1: string; city: string; province: string; postal: string; note?: string };
    expected: { code: string; qty: number }[];
    raw: unknown;                        // stored verbatim on custode.ticket.raw_payload
  } | null>;
}
```

Adapters live in `packages/api/src/adapters/<provider-slug>.ts`. One file per provider, no shared
"universal CRM" abstraction — that abstraction is always wrong by the third provider.

### Minimum necessary

The adapter contract is the enforcement point for data minimisation. It returns **name, address,
phone, email, language and expected lines. Nothing else.** An over-broad API token must not be able to
pull account balances, credit status or device history into CUSTODE, and the way you guarantee that is
by having nowhere to put it. `raw_payload` is stored for dispute purposes and is subject to the same
purge as the rest of `pii`.

---

## 5.3 Webhooks out

Providers register URLs; CUSTODE POSTs every custody event that concerns them.

```http
POST https://their-crm.example.com/hooks/custode
x-custode-signature: t=1756137600,v1=<hex hmac>
x-custode-event: custody.released
x-custode-delivery: dlv_01J...
content-type: application/json

{ "id":"evt_01J...", "type":"custody.released", "at":"2026-08-25T14:12:09Z",
  "movement_ref":"M-4473", "ticket_ref":"BM-1042", "box_ref":"BX-1042",
  "data":{ "seal_no":"CS-40118", "signer_name":"G. Bilodeau" },
  "hash":"9f2c…", "prev_hash":"07a7…" }
```

**Signature** — Stripe-style, to make replay attacks expensive:

```ts
const signed = `${timestamp}.${rawBody}`;
const v1 = hmacSha256(providerWebhookSecret, signed);
// receiver: reject if |now - timestamp| > 300s, compare with timingSafeEqual
```

**Subscribable types** — a subset of §2.3, never the admin or unseal-internal events:

```
movement.booked      driver.accepted     custody.accepted    otp.issued
otp.failed           custody.released    movement.delivered  movement.exception
movement.cancelled   movement.recalled   seal.voided         address.overridden
```

**Delivery**

| Property | Rule |
|---|---|
| Ordering | Per movement, in `seq` order. A failed delivery blocks later events **for that movement only**. |
| Retries | 8 attempts: 10 s, 30 s, 2 m, 10 m, 1 h, 6 h, 24 h, 48 h. |
| Timeout | 5 s connect, 10 s total. Any 2xx is success. |
| Failure | After 8 attempts the endpoint is marked `DEGRADED` and the provider admin is emailed. Events are retained 30 days for replay. |
| Replay | `POST /provider/sandbox/replay`, and `POST /provider/webhooks/:id/replay?from=<seq>` in production. |

```sql
CREATE TABLE custode.webhook_endpoint (
  id text PRIMARY KEY, provider_id text NOT NULL REFERENCES custode.provider(id),
  url text NOT NULL, secret_hash text NOT NULL, types text[] NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DEGRADED','DISABLED')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE custode.webhook_delivery (
  id text PRIMARY KEY, endpoint_id text NOT NULL, event_seq bigint NOT NULL,
  attempt smallint NOT NULL DEFAULT 0, status_code int, error text,
  next_attempt_at timestamptz, delivered_at timestamptz,
  UNIQUE (endpoint_id, event_seq)
) PARTITION BY RANGE (next_attempt_at);
```

The `UNIQUE (endpoint_id, event_seq)` is the idempotency guarantee: an event is delivered to an
endpoint at most once successfully, regardless of worker restarts.

---

## 5.4 Sandbox

Every provider gets sandbox keys on day one, before any contract is signed. A CRM team asks for a test
environment on the first call, and not having one costs weeks.

- Prefix `sk_test_` vs `sk_live_`; the two datasets never touch.
- Sandbox movements can be driven through the whole lifecycle by API without a real driver:
  `POST /sandbox/movements/:ref/advance { "to":"DELIVERED" }`.
- Sandbox OTPs are always `000000` and are returned in the response, clearly labelled.
- Sandbox webhooks fire against their URL with `x-custode-livemode: false`.

---

## 5.5 Labels

The label is generated server-side as a PDF, 4×6 inches, and is fetched by the packing desk after
booking.

```http
GET /movements/:ref/label.pdf?copy=1
  → 200 application/pdf
```

Contents — and this list is exhaustive:

| Zone | Content |
|---|---|
| Header | CUSTODE seal mark, wordmark, `movement_ref` |
| Service band | Service name and window, high contrast |
| Deliver to | Recipient name, language chip, unit, street, city, province, postal, phone, delivery note |
| From | Store name only |
| Barcode | `box_ref` as Code 128, plus human-readable |
| Footer chips | `SEAL CS-#####`, `TICKET BM-####`, `SIGNATURE + CODE REQUIRED` |

**The label MUST NOT carry any of:** product names, SKUs, IMEIs, quantities, declared value, any
currency symbol, or provider branding. A box labelled "iPhone 16 Pro" is an advertisement to whoever
walks past it, and an unbranded box is a safer box.

There is an automated test asserting the rendered PDF text layer contains none of those. Keep it —
it is exactly the kind of thing someone adds back in six months because "the driver wanted to know
what's in it."

Every fetch chains `label.printed` with the copy number. Reprints are counted; a label printed four
times is worth someone noticing.
