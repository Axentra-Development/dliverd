# 10. Driver app (React Native)

React Native 0.74+ · TypeScript · Expo with a development build (config plugins are needed for
background location and mock detection, so managed Expo Go is not sufficient) · shared `packages/core`.

React Native was chosen over a PWA for exactly three capabilities. iOS gives none of them to a web
app, and all three are load-bearing:

1. **Background location** — the geofence and off-route alarm need position when the app is not
   foregrounded.
2. **Mock-location detection** — without it the geofence is theatre.
3. **Reliable push** — route offers and dispatcher messages cannot depend on an open tab.

---

## 10.1 Screens

| # | Screen | Contents |
|---|---|---|
| 1 | **Login** | Phone or work email → 6-digit code. Device bound. |
| 2 | **Dashboard** | Online toggle with eligibility blockers ("insurance expired — you cannot go online"), today's earnings, stops remaining, next stop card. |
| 3 | **Daily route** | Ordered stop list, each with kind (pickup/deliver), ETA, provider or recipient first name, address, pay. Re-route banner when one is suggested. |
| 4 | **Stop detail** | The handover flow. See §10.2. |
| 5 | **Add-on offers** | Accept / decline. Offers that would break a promised window are never shown (§3.9). |
| 6 | **Earnings** | Per stop, waiting time, surcharges, weekly statement PDF. |
| 7 | **Profile** | Documents and expiries, SOP acknowledgement, vehicle, language, support. |

Persistent: an **SOS** control reachable from every screen.

The driver never sees the manifest or the declared value. A driver who knows a box holds $9,000 is
carrying a different kind of risk, and they cannot attest to contents anyway.

---

## 10.2 The handover flow

Identical shape at pickup and at delivery. Each step is its own API call, individually idempotent and
individually queueable.

```
1  Scan box reference          → server returns the seal number it expects
2  Scan / confirm seal number  → match or refuse. Mismatch ends the flow.
3  Photograph the seal         → SEAL_AT_PICKUP or SEAL_AT_DOOR
4  Enter the code              → 6 digits, 5 attempts, never shown to the driver
5  Capture the signature       → name typed, signed, geo-stamped
   ↓
   custody accepted / released
```

Gates rendered as blocking cards, never as a disabled button with no explanation:

| Gate | Card |
|---|---|
| Outside geofence | *"Handover locked by GPS — you are 340 m from the delivery point."* Distance updates live. |
| GPS accuracy poor | *"Waiting for a better GPS fix."* After 60 s, offer "Request dispatcher override." |
| Mocked location | *"Location services report a simulated position. This handover cannot continue."* Chained, dispatch alerted. |
| Seal mismatch | *"This is not the seal on the manifest. Do not accept this box."* → refuse flow. |
| Step 4 before step 3 | Signature panel is not rendered until the code verifies. |

**Refuse at pickup** is a first-class path: broken seal, wrong seal, box not ready. Reason code +
photo + note. A driver must be able to decline custody before it starts.

---

## 10.3 Offline

Montréal has underground garages, elevators, concrete stairwells and dead zones on the couronne. The
geofence lock makes offline capability urgent rather than nice: a driver at the right door with no
signal must still be able to complete a handover.

```ts
// packages/mobile-driver/src/offline/queue.ts
type QueuedOp = {
  id: string;                      // client ULID = the Idempotency-Key
  endpoint: string; method: 'POST';
  body: unknown; blobs: string[];  // local file URIs, uploaded first
  createdAt: string; attempts: number; movementRef: string;
};
```

| Rule | Detail |
|---|---|
| Storage | SQLite (`expo-sqlite`), not AsyncStorage. Ordered, durable, survives a crash mid-write. |
| Ordering | Strictly FIFO **per movement**. A blocked movement never blocks another. |
| Idempotency | Client-generated ULID sent as `Idempotency-Key`. Replays are safe by construction. |
| Blobs | Photos and signatures written to disk immediately, uploaded before the op that references them. Never held in memory awaiting signal. |
| Geofence offline | Evaluated **on-device** against the stop coordinates cached with the route. The server re-validates on sync; a disagreement raises an alert rather than reversing a completed handover. |
| OTP offline | The code hash for the active stop is **not** cached — verification requires the server. If offline at step 4, the app captures the code, queues it, and shows *"Code will be verified when signal returns."* The handover completes provisionally and the server confirms. A wrong code discovered on sync raises an exception, it does not silently fail. |
| Conflict | Server response is authoritative. A queued op rejected as `409` surfaces as an in-app task, never silently dropped. |
| Visibility | A persistent banner shows queued-op count. The driver always knows what has not reached the server. |

The OTP rule is the one genuine compromise in this system. The alternative — refusing handovers
without signal — strands drivers at doors. Provisional completion with server confirmation is the
lesser risk, and it is chained as such.

---

## 10.4 Location

```ts
const CONFIG = {
  foregroundIntervalMs: 15_000,
  backgroundIntervalMs: 60_000,
  handoverIntervalMs: 2_000,      // high frequency only while a stop is open
  distanceFilterM: 25,
  geofenceM: 100,
  accuracyFloorM: 100,
};
```

| Concern | Implementation |
|---|---|
| Background | `expo-location` background task, iOS `UIBackgroundModes: location`, Android foreground service with a persistent notification. |
| Permission copy | Explain *before* the OS prompt why "Always" is required: "CUSTODE records position only while you are on a route, to prove where each handover happened." A denied Always permission blocks going online, with that reason shown. |
| Mock detection | Android `Location.isFromMockProvider`; iOS via a native module checking simulation indicators plus plausibility (impossible speed, teleport, zero jitter). |
| Batching | Pings buffered and POSTed every 60 s, or immediately during a handover. |
| Battery | Stop all location work when offline/off-shift. Report `battery_pct`; dispatch sees a driver about to go dark. |
| Privacy | Location is collected **only between going online and going offline**. Never off-shift. Stated in the SOP and in the app. |

---

## 10.5 Scanning and camera

| Need | Implementation |
|---|---|
| Symbologies | Code 128, EAN-13, UPC-A, QR, Data Matrix, ITF. Pick the library for this on day one — retrofitting symbologies is painful. |
| Library | `expo-camera` barcode scanning; fall back to `vision-camera` + MLKit if performance is short. |
| Torch | Toggle, remembered per driver. Loading docks are dark. |
| Manual entry | Always available beside the scanner. A damaged barcode must never strand a driver. |
| Photos | 1600 px longest edge, JPEG q0.7, ~200–400 KB. Written to disk before upload. GPS and timestamp written by us, other EXIF stripped. |
| Signature | `react-native-svg` path capture → PNG. Minimum stroke length enforced so a single tap is not a signature. |

---

## 10.6 Push

| Type | Priority | Behaviour |
|---|---|---|
| Route offered (morning) | high | Full-screen-ish, sound |
| Add-on offer | high | Time-limited, shows expiry countdown |
| Dispatcher message | high | Opens the thread |
| Re-route suggestion | normal | Only when saving > 8 min (§7.5) |
| SOS acknowledged | max | Bypasses do-not-disturb |
| Document expiring | low | Daily digest |

Token registered per device on login, revoked on logout, and cleared server-side when a driver is
offboarded.

---

## 10.7 Security on the device

- No manifest, no declared value, no recipient email ever stored on device.
- Recipient phone number held only for the active stop, purged on completion.
- Tokens in Keychain / Keystore, never AsyncStorage.
- Refresh token bound to `device_id`; a new device forces re-auth.
- Certificate pinning on the API host.
- Screenshot blocking on the handover screens (Android `FLAG_SECURE`; iOS best-effort).
- Remote wipe: `SUPER_ADMIN` revokes the device, and the app clears its queue and cache on next
  contact — after uploading anything still queued.
- Jailbreak / root detection is **advisory**: log it, alert dispatch, do not brick a driver mid-route.

---

## 10.8 Release

| Concern | Rule |
|---|---|
| Stores | Apple Developer Program ($99/yr) and Google Play ($25 once). Budget 5–7 days for first review. |
| OTA | Expo Updates for JS-only fixes. Anything touching location, camera or permissions needs a store build. |
| Versioning | The API supports the current and previous minor mobile version. Older builds get a forced-update screen. |
| Crash reporting | Sentry, with PII scrubbing configured before the first release, not after. |
| Beta | TestFlight and Play internal testing for the two owner-drivers throughout month one. Real routes, real boxes, real dead zones — the offline queue cannot be validated in an office.
