# 6. Security, privacy and controls

---

## 6.1 Threat model

The realistic adversaries, in the order they will actually appear:

| # | Threat | Control |
|---|---|---|
| 1 | **Store insider redirects a high-value box** to an address they control | `address_fetched` stored immutably before any edit · material change needs a reason · manager approval above $2,000 · material overrides in a review queue · both addresses in the chain forever |
| 2 | **Store insider opens a sealed box** and swaps an item | Unseal requires a second person's OTP · seal voided permanently · `seal_count` on the recipient's receipt |
| 3 | **Driver opens a box** in transit | Tamper-evident seal · seal photographed at pickup and at the door · seal number originates with the provider, never the driver |
| 4 | **Driver spoofs GPS** to complete a handover elsewhere | OS mock-location flag checked on every ping and at handover · accuracy floor · handover refused and chained |
| 5 | **Rep learns the control surface** and works around it | Ledger is invisible to `STORE_REP` — `403`, no count, no hint |
| 6 | **Rep self-promotes to manager** to approve their own unseal | `STORE_MANAGER` assignable only by `SUPER_ADMIN`, enforced by DB trigger |
| 7 | **Recipient claims non-delivery** | Two proofs + geofence + signature + door photo + chain |
| 8 | **Provider claims we lost items** we never saw | The two bindings (§0.1) · their own scan record · terms clause |
| 9 | **Stolen driver phone** | Short access tokens, device-bound refresh, remote revoke, no manifest on device |
| 10 | **Leaked provider API key** | Hashed at rest, scoped, rotatable, rate limited, anomaly on volume spike |
| 11 | **Admin quietly edits a rate or a movement** | Admin actions chain into the same ledger; no `UPDATE` grant on the ledger table |
| 12 | **Ledger tampering at the database** | Hash chain + nightly verify + daily Merkle root timestamped externally |

---

## 6.2 Secrets and keys

| Secret | Storage |
|---|---|
| Provider API keys | `argon2id` hash. Plaintext shown **once** at creation. Prefix `sk_live_`/`sk_test_` + 32 random bytes base62. |
| Webhook secrets | `argon2id` hash; a display copy encrypted with Key Vault for the provider's own UI. |
| OTP codes | `argon2id` hash. **Never stored or logged in plaintext, never returned in any API response outside sandbox.** |
| JWT signing | Asymmetric (EdDSA), private key in Azure Key Vault, rotated quarterly with overlap. |
| DB credentials | Managed identity. No connection string in app settings. |
| Blob access | Short-lived user-delegation SAS, 15 min, per object. |

Key rotation is a first-class endpoint, not a support ticket: `POST /provider/keys` issues a new key
while the old one still works, and `DELETE /provider/keys/:id` revokes it. Both chain.

---

## 6.3 Authentication

**Passwordless everywhere.** There are no passwords in this system, which removes credential stuffing,
reuse and reset flows in one decision.

- Identifier is a phone number (E.164) or a work email.
- 6-digit code, 10 minutes, 5 attempts, single use, invalidated on a new request.
- Enumeration-safe: `POST /auth/request-code` always returns `202`.
- Driver refresh tokens bound to `device_id`; a token presented from a new device forces re-auth.
- Refresh rotation with reuse detection: presenting a consumed refresh token revokes the family and
  raises an alert.

**Roadmap, not v1:** Entra ID (Microsoft 365) SSO for provider staff. When a provider is already an
M365 tenant, federating removes user lifecycle work entirely — a departing employee loses CUSTODE
access the moment IT disables their account. Design `app_user` with a nullable `external_idp_subject`
now so this is an additive migration.

---

## 6.4 Authorisation

Enforced in one place, consulted by every route:

```ts
// packages/api/src/authz.ts
export function can(p: Principal, action: Action, res?: Resource): boolean { … }

// route registration cannot omit it
app.post('/boxes/:id/seal', { preHandler: requires('box.seal') }, handler);
```

Scope resolution:

| Principal | Scope |
|---|---|
| `SUPER_ADMIN` | everything |
| `DISPATCHER` | all movements; no config, no billing, no PII purge |
| `DRIVER` | movements where `driver_id = self` **and** status in `ASSIGNED, PICKED_UP` |
| `PROVIDER_ADMIN` | `provider_id = self` |
| `STORE_MANAGER` | `store_id = self` |
| `STORE_REP` | `store_id = self`, minus ledger, minus unseal approval |
| recipient token | exactly one `movement_id` |

Postgres **row-level security** mirrors the same rules as a second line of defence. Application bugs
are normal; a bug that also has to defeat RLS is much rarer.

```sql
ALTER TABLE custode.movement ENABLE ROW LEVEL SECURITY;
CREATE POLICY store_scope ON custode.movement FOR SELECT
  USING (store_id = current_setting('custode.store_id', true)
         OR current_setting('custode.role', true) IN ('SUPER_ADMIN','DISPATCHER'));
```

---

## 6.5 The ledger gate

Because it was a deliberate decision and will be re-litigated:

> `STORE_REP` cannot see the custody chain. Not a redacted version, not a count, not a placeholder.
> `GET /ledger` returns `403` and the provider UI renders no chain component at all.

Two reasons. It is an audit trail **of staff** — override reasons, failed unlock codes, names against
timestamps — which is not a rep's business. And someone who can watch exactly what gets recorded
learns exactly what does not, which is how controls get worked around.

The corresponding obligation sits outside the software: staff MUST be told in writing, in the
employment agreement or the SOP acknowledgement, that their scans, address confirmations and unlock
requests are attributed to them. Attributed activity logging is far cleaner under Québec law when it
is disclosed up front, and the same signed SOP is what the insurer wants anyway.

---

## 6.6 Law 25 (Québec)

| Obligation | Implementation |
|---|---|
| Named privacy officer | Owner. Named in the privacy notice, in the provider contract, and on the tracker. |
| Privacy notice at collection | Shown on the first tracker view, in the recipient's language, before anything else. |
| Purpose limitation | Adapter contract returns six fields (§5.2). There is nowhere to put more. |
| Right of access | `GET /track/:token/receipt.pdf` + `POST /privacy/access-request` |
| Right of erasure | `POST /admin/pii/purge` nulls `pii.*` and stamps `purged_at`. The chain survives (§2.4). |
| Retention | 24 months post-delivery for PII, automatic nightly purge; 7 years for the ledger |
| Breach register | `custode.privacy_incident` table; assessment of "risk of serious injury" recorded per incident |
| Processor agreements | Every provider contract carries a data-handling schedule. Sub-processors (SMS, maps, hosting) listed publicly. |
| Data residency | **Azure Canada Central**, with Canada East for geo-redundant backup. No data leaves Canada. |
| Automated decision-making | The router (§7) suggests; it never decides anything about a person. Documented as such. |

**Bill 96** is a product requirement, not a translation task: French is the default locale, every
notification, receipt, label and driver screen is native in French, and the English version is the
translation — not the other way round.

---

## 6.7 Application security baseline

- TLS 1.2+ only; HSTS with preload on all web origins.
- CSP on every web app: `default-src 'self'`, no inline script, nonce-based where unavoidable.
- No third-party analytics, tag managers or session recorders on any surface that shows PII. This is
  not negotiable on the tracker or the packing desk.
- All input validated by `zod` at the edge; nothing hand-parsed.
- Parameterised SQL only. An ORM is optional; string-concatenated SQL is a release blocker.
- Blob uploads: server issues a scoped SAS, validates content type and magic bytes on completion,
  strips EXIF **except** the GPS and timestamp we wrote ourselves.
- Dependency scanning on every PR; `npm audit --omit=dev` clean at high severity before merge.
- Secrets scanning pre-commit and in CI.
- Structured logs, no PII, no OTP, no full addresses. Log `movement_ref`, `address_hash`, never
  `line1`.

---

## 6.8 Compliance roadmap

Not v1, but design so it is not a rewrite:

1. **SOC 2 Type I** once there is a contractor and a second admin — roughly month 9.
2. **ISO 27001** if an enterprise provider requires it. Dispatch Science carries ISO 27001 + HIPAA +
   FedRAMP + SOC 1 & 2; eLogii carries ISO 27001 + SOC 2 Type II. Enterprise buyers will ask.
3. Keep an evidence trail from day one: change management is GitHub PRs, access reviews are quarterly
   and recorded, and incidents live in one register. Retrofitting evidence is what makes these audits
   expensive.
