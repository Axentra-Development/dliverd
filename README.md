# Dliverd

High-value device custody — pickup, geofenced handover (code + signature), trade-in, add-ons.

## Apps

| App | Path | Status |
| --- | --- | --- |
| Driver | [`apps/driver`](apps/driver) | In progress |
| Client | [`apps/client`](apps/client) | In progress |
| Provider | `apps/provider` | Next |
| Dispatch | `apps/dispatch` | Next |

Open from the repo root, or jump straight to `apps/driver/index.html` / `apps/client/index.html`.

## iOS (Xcode)

The driver runs as a native iPhone app via WKWebView:

```
ios/Custode.xcodeproj
```

Open that project in Xcode, pick an iPhone simulator, press Run. Select your Apple development team under **Signing & Capabilities** the first time (`ca.axentra.custode.driver`).

**Driver** — Maya: `514-555-0199` / `maya@dliverd.ca`, Rami: `514-555-0244` / `rami@dliverd.ca`, login code **246810**. Provider release: **902314**.

**Client** — Geneviève: `514-328-4419` / `g.bilodeau@icloud.com`, Gino: `450-681-2274` / `gino.pensato@gmail.com`, Samuel: `514-907-1183` / `samuel.duchesneau@proton.me`, login code **246810**. Door code (shown only when the driver is in the geofence): **417826**.
