# Custode

High-value device custody — pickup, geofenced handover (code + signature), trade-in, add-ons.

## Apps

| App | Path | Status |
| --- | --- | --- |
| Driver | [`apps/driver`](apps/driver) | In progress |
| Client | `apps/client` | Next |
| Provider | `apps/provider` | Next |
| Dispatch | `apps/dispatch` | Next |

Open the driver app: `apps/driver/index.html`

## iOS (Xcode)

The driver runs as a native iPhone app via WKWebView:

```
ios/Custode.xcodeproj
```

Open that project in Xcode, pick an iPhone simulator, press Run. Select your Apple development team under **Signing & Capabilities** the first time (`ca.axentra.custode.driver`).

Sign in with a demo account (Maya: `514-555-0199` / `maya@custode.ca`, Rami: `514-555-0244` / `rami@custode.ca`) and code **246810**. Client handover code: **417826**. Provider release: **902314**.
