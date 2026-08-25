# Dliverd

High-value device custody — pickup, geofenced handover (code + signature), trade-in, add-ons.

Open `index.html` for the role picker. Every app is a self-contained live demo.

## Apps

| App | Role | Path | Form |
| --- | --- | --- | --- |
| Driver | Maya Chahwan · MTL-03 | [`apps/driver`](apps/driver) | iPhone |
| Client | Geneviève Bilodeau — Ship / Pick-Up / Return / Cancel | [`apps/client`](apps/client) | iPhone |
| Provider | Management (Chantal) + Representative (Karim), BMobile Saint-Laurent | [`apps/provider`](apps/provider) | iPhone |
| Route Manager | Rami Aziz — dispatch board | [`apps/dispatch`](apps/dispatch) | Desktop |
| Super Admin | Maya Chahwan — console | [`apps/admin`](apps/admin) | Desktop |

## Demo codes

Driver sign-in: `514-555-0199` / `maya@dliverd.ca` (or Rami: `514-555-0244` / `rami@dliverd.ca`), OTP **246810**, then Face ID or PIN **2468**.
Client handover code: **417826**. Provider release: **902314**.

## iOS (Xcode)

The whole suite runs as a native iPhone app via WKWebView — it opens on the role picker,
and an edge-swipe goes back:

```
ios/Dliverd.xcodeproj
```

Open the project in Xcode, pick an iPhone simulator, press Run. A build phase syncs
`index.html` + `apps/` into the bundle (`Dliverd/www/`). Select your Apple development
team under **Signing & Capabilities** the first time (`ca.axentra.dliverd`).
