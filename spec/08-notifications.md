# 8. Notifications and language

---

## 8.1 The rule that governs the rest

**Three to five messages per delivery. No more.** Over-notifying trains people to ignore the one
message that matters, and the one that matters is *"the driver is approaching."*

That message carries the highest operational value — it is what gets the recipient to the door — and
it is where the OTP belongs. Sending the code at booking gives an attacker hours to socially engineer
it; sending it when the driver is ten minutes out is the security-correct default.

---

## 8.2 Recipient sequence

| # | Trigger | Channel | Content | Optional |
|---|---|---|---|---|
| 1 | `movement.booked` | SMS | "BMobile is sending you a package with CUSTODE. Track it: {link}" + privacy notice link | no |
| 2 | `driver.accepted` + route planned | SMS | "Arriving tomorrow between 08:00 and 10:30." Only if the window narrowed materially. | yes |
| 3 | **driver approaching** (< 10 min or < 2 stops) | SMS | "Your CUSTODE driver arrives in about 8 minutes. **Your code is 417826.** Have it ready — and check the seal is intact before you sign." | **no** |
| 4 | `movement.delivered` | SMS + email | "Delivered at 09:41, signed by G. Bilodeau. Receipt: {link}" | no |
| 5 | `movement.exception` | SMS | reason in plain words + what happens next + reschedule link | no |

Nothing else. No "we've received your order", no "your driver has started their day", no ratings
nag on a separate message — the rating lives inside the delivered message's link.

**Message 3 also carries the seal instruction.** The recipient is the last party able to catch a
compromised box, and asking them to look costs one clause.

---

## 8.3 Other audiences

| Audience | Event | Channel |
|---|---|---|
| Store user | unseal code | SMS to the **approver**, never the requester |
| Store user | movement exception on their box | in-app + email digest |
| Provider admin | webhook endpoint degraded | email |
| Provider admin | material address override at their store | daily digest |
| Driver | route offered, add-on offer, dispatcher message, SOS acknowledged | push (FCM/APNs) |
| Dispatcher | SOS, mocked location, seal mismatch, off-route, SLA at risk | in-app + push, SOS also SMS |
| Super admin | chain verification failure, seal-range exhaustion, insurance expiring in 30 days | email + SMS |

**SOS is the only notification that bypasses every quiet hour and every batching rule.**

---

## 8.4 Delivery mechanics

```sql
CREATE TABLE custode.notification (
  id           text PRIMARY KEY,
  movement_id  text REFERENCES custode.movement(id),
  audience     text NOT NULL,            -- RECIPIENT | STORE_USER | DRIVER | DISPATCH | PROVIDER
  channel      text NOT NULL CHECK (channel IN ('SMS','EMAIL','PUSH','INAPP')),
  template_key text NOT NULL,
  locale       text NOT NULL,
  to_masked    text NOT NULL,            -- never the full number
  status       text NOT NULL DEFAULT 'QUEUED'
               CHECK (status IN ('QUEUED','SENT','DELIVERED','FAILED','SUPPRESSED')),
  provider_msg_id text,
  sent_at timestamptz, failed_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON custode.notification (movement_id, template_key)
  WHERE template_key IN ('booked','approaching','delivered');
```

That partial unique index is the anti-spam guarantee: the three core messages can be sent **once per
movement**, regardless of retries, worker restarts or re-routes. A re-route does not re-send
"approaching."

| Concern | Rule |
|---|---|
| Quiet hours | 21:00–08:00 local. Queued, not dropped. SOS and `approaching` for an EVENING service are exempt. |
| SMS provider | Twilio (Canadian long code or short code). Abstract behind `SmsProvider` so it is replaceable. |
| OTP transport | Twilio Verify for delivery codes. The hook point is `issueOtp()`. Codes never appear in application logs. |
| Failure | An undelivered `approaching` message escalates to a voice call attempt for `EVENING` and high-declared movements. |
| Opt-out | Transactional, so STOP handling is legally narrow — but honour it, mark `SUPPRESSED`, and tell dispatch the recipient cannot be reached by SMS. |

---

## 8.5 Language

**French is the default and the source of truth.** English is the translation. Bill 96 makes this a
condition of operating, not a feature.

```
packages/core/i18n/
├── fr-CA.json          # authored first, always complete
└── en-CA.json          # translated; CI fails if a key is missing
```

| Rule | Detail |
|---|---|
| Locale resolution | recipient → `pii.recipient.locale` from the CRM · staff → `app_user.locale` · fallback `fr-CA` |
| No inline strings | Every user-facing string is a key. CI greps for bare text in JSX and fails the build. |
| Interpolation | ICU MessageFormat, for plurals and gender. `{count, plural, one{# article} other{# articles}}` |
| Dates, times, money | `Intl` with the user's locale, `America/Toronto`, CAD. Never hand-formatted. |
| Addresses | Never translated or reordered. Rendered exactly as stored. |
| Exception codes | Stored as codes, rendered per locale. Never store a translated string. |
| Label PDF | Rendered in the **recipient's** locale, with the language chip visible so the driver knows which language to greet in. |
| Receipt PDF | Bilingual — one document, both languages, because it may be read by an insurer, a court or the provider. |

```json
// fr-CA.json
{ "track.approaching": "Votre livreur CUSTODE arrive dans environ {minutes} minutes. Votre code est {code}. Vérifiez que le sceau est intact avant de signer.",
  "pack.seal.blocked.address": "Bloqué — l'adresse de livraison n'a pas été confirmée.",
  "driver.geofence.locked": "Remise verrouillée par le GPS — vous êtes à {distance} m du point de livraison." }
```

---

## 8.6 Accessibility

The signature step is a mandatory canvas interaction, which makes it an accessibility barrier until
proven otherwise. Treat it as a first-class requirement, not a retrofit.

| Surface | Requirement |
|---|---|
| All web | WCAG 2.2 AA. Keyboard reachable, visible focus, 4.5:1 text contrast, `prefers-reduced-motion` honoured. |
| Tracker | Screen-reader tested. Status announced via `aria-live="polite"`. The OTP is selectable text, never an image. |
| Signature (driver-held device) | Alternative path: the driver may record **"signature declined — accessibility"** with a reason, and the handover completes on OTP + photo + geofence. This path is chained, is reported, and exists precisely so a disabled recipient is never refused a delivery. |
| Packing desk | Fully operable with a USB wedge scanner and keyboard only, no pointer required. |
| Driver app | Dynamic Type / font scaling to 200% without loss of function. Tap targets ≥ 44 pt. High-contrast mode for sunlight. |
| Colour | Status is never encoded by colour alone — every state carries a label or an icon. |
