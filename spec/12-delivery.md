# 12. Infrastructure and delivery plan

---

## 12.1 Azure footprint

Everything in **Canada Central**, geo-redundant backup to **Canada East**. No data leaves Canada.

| Component | Service | Tier at launch | Notes |
|---|---|---|---|
| API | App Service, Linux, Node 20 | B1 → P1v3 | Always On. Health check `/health`. |
| Database | Azure Database for PostgreSQL Flexible Server | B2s, 32 GB | PITR 35 days. Scale to GP when contractor #1 signs. |
| Blobs | Storage Account, Blob | Hot + immutable policy | Signatures, photos, labels, exports. Legal-hold capable. |
| Secrets | Key Vault | Standard | JWT keys, SMS credentials, webhook secrets |
| Queues | Storage Queues | — | Webhook delivery, notifications, exports, routing jobs |
| Jobs | Container Apps Jobs | Consumption | Nightly: chain verify, Merkle root, PII purge, ping rollup |
| CDN | Front Door Standard | — | Web apps + WAF + TLS + HSTS |
| Monitoring | Azure Monitor + Log Analytics | 30-day retention | |
| Identity | Entra ID | — | CUSTODE staff today; provider SSO later (§6.3) |

Estimated run cost at launch: **CAD $180–260/month**. Under $400 through the first contractor.

Everything is defined in Bicep under `infra/`. There is no click-ops resource; a resource that exists
only in the portal will be deleted by the next deployment and nobody will know why.

---

## 12.2 Environments

| Env | Purpose | Data |
|---|---|---|
| `local` | Developer machines | Docker Postgres, seed fixtures, SMS and maps stubbed |
| `sandbox` | Provider integration testing — **live from day one** | Synthetic only. OTPs always `000000`. Never touches production. |
| `prod` | Real | Real |

There is deliberately no staging environment at this size. Sandbox with production-shaped fixtures
catches what staging would, and a third environment is a third thing to keep patched.

---

## 12.3 CI/CD

```yaml
# .github/workflows/ci.yml  (shape, not the whole file)
on: [pull_request, push]
jobs:
  verify:
    steps:
      - typecheck            # tsc --noEmit, all packages
      - lint                 # eslint + the i18n bare-string rule
      - unit                 # vitest
      - integration          # testcontainers postgres, all migrations forward
      - property             # fast-check chain integrity
      - contract             # generated OpenAPI vs handlers
      - audit                # npm audit high, secret scan
      - e2e                  # playwright, the five journeys
  deploy:
    if: github.ref == 'refs/heads/main'
    steps:
      - migrate              # forward-only, run before the app swap
      - deploy api           # slot swap with health gate
      - deploy web           # three static bundles to Front Door
      - smoke                # book + deliver one sandbox movement end to end
```

Rules:

- **Forward-only migrations.** No down scripts — the ledger must never be rolled back. A bad migration
  is fixed by a new migration.
- Migrations run *before* the app swap and must be backward compatible with the previous release, so
  a failed deploy can swap back.
- A red `verify` blocks merge. There is no override.
- Mobile releases are cut from tags; the API supports current and previous minor (§10.8).

---

## 12.4 Build phases

Sequenced by what blocks what, not by role. Everything in Phase 0 and 1 is required before a paying
movement.

### Phase 0 — Foundations (week 1–2)

1. Monorepo, `core` package, CI green with one real test.
2. Migrations 0001: all tables, RLS, ledger triggers, **PII in its own schema with hashed addresses in
   the chain from the very first migration** (§2.4).
3. Auth: passwordless, roles, the `can()` gate, RLS policies.
4. Ledger append + verify + the property test.

### Phase 1 — The packing desk (week 2–4)

5. **Scan-to-seal session**: box, scan (all item types, Luhn by type), reconcile, unknown-item
   capture, seal from a controlled range, manifest lock.
6. **Ticket lookup by scanned barcode** — rung 3, zero integration.
7. **Address: as-fetched immutable, as-shipped, override reasons, confirm action, seal gate.**
8. Recipient contact fields. *Nothing client-facing can be built until these exist.*
9. Unseal with dual-control OTP, seal voiding, recall, lockout.
10. Label PDF with the leak test.
11. Booking, rate card, cutoffs, cancellation quotes.

### Phase 2 — Movement (week 4–7)

12. Dispatch: offer, first-accept-wins, insertion scoring.
13. Driver app: login, route, stop detail, the five-step handover, geofence, mock detection.
14. **Offline queue.** Before the first underground garage, not after.
15. Photos, seal match, refuse-at-pickup.
16. Exceptions and the dispatcher resolution paths, including **reassign in custody**.
17. Webhooks out.

### Phase 3 — The recipient (week 6–8)

18. Tracker: token, states, live map.
19. Notifications: the three-to-five sequence, OTP bundled into *approaching*.
20. **FR/EN across every surface.** Bill 96 is a condition of operating.
21. Receipt PDF with the chain and the declared-by line.
22. Report-an-issue → claims.

### Phase 4 — Control and evidence (week 8–11)

23. Admin console: ledger explorer, verify button, override queue, anomalies.
24. Daily Merkle root with external timestamping.
25. Export bundle.
26. Driver onboarding file, expiry alerts, payouts.
27. Provider portal: SLA stats, invoices, claims, sandbox keys, key rotation.

### Phase 5 — Intelligence (week 10+)

28. Traffic-aware ETAs; the tracker window narrows.
29. Dwell and travel logging — *actually shipped in Phase 1*, surfaced here.
30. Event-triggered re-sequencing on the custody-exposure objective.
31. Learned dwell, parking, `p_absent`.
32. Provider CRM adapters — rungs 1 and 2, per provider, as they are sold.

---

## 12.5 Sequencing notes that matter

**Two things must ship in Phase 0/1 even though nothing visibly depends on them yet.** Both are nearly
free now and structurally expensive later:

- **Hashed addresses with per-movement salt in the ledger** (§2.4). Retrofitting after a year means
  choosing between a broken chain and refusing a lawful deletion request.
- **`dwell_seconds` and `travel_seconds` on every stop** (§7.8). The routing model needs eight to ten
  weeks of our own data before it beats a plain traffic API, and this data cannot be reconstructed.

**One thing outranks everything in this document and is not software.** Insurance is the only true
launch blocker. Phases 0 and 1 can proceed while the policy is quoted; the driver onboarding file
(item 26) is what the underwriter will actually read, so pull it forward the moment a quote is in
progress.

**One thing needs a lawyer despite professional fees being cut in-house.** The terms of carriage clause
that says *product selection and pick accuracy are expressly the shipper's responsibility, evidenced by
their own packing scans*. That single clause is the legal form of §0.1, and it decides who pays for a
$1,449 mistake.

---

## 12.6 Definition of done, per feature

A feature is done when all of these are true. Not four of five.

- [ ] Server-side authorisation enforced and tested for every role, including the denial case
- [ ] Every state change appends a ledger event with the correct actor
- [ ] Request and response validated by a `zod` schema shared with the clients
- [ ] `fr-CA` and `en-CA` strings present; no bare text in JSX
- [ ] Error paths surface the server's `detail`, never a generic message
- [ ] Empty, loading and offline states designed
- [ ] Integration test covering the guard, not only the happy path
- [ ] No PII, OTP or full address in any log line
- [ ] Works at 390 px wide and at 200% font scale
- [ ] The relevant §11.2 invariant is asserted somewhere
