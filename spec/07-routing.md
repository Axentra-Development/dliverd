# 7. Routing service

A separate worker (`packages/api/src/routing/`) that plans and re-plans routes. It **suggests**; it
never silently rearranges a device already in custody, and it never makes a decision about a person.

---

## 7.1 The objective function

Commercial optimisers minimise distance or drive time. Both are wrong here. Two routes that take four
hours are not equal if one leaves $9,000 of phones in a car until 15:00 and the other clears the
high-value stops by 11:00.

```
minimise   Σ over stops ( declared_cents(stop) × minutes_in_vehicle(stop) )
         + λ_late  × Σ max(0, eta − promised_to)²
         + λ_fail  × Σ p_absent(stop) × cost_of_failed_attempt
subject to
   promised windows                       (hard)
   recipient must be present              (hard — mandatory signature)
   no unattended drop                     (hard, always)
   driver shift length                    (hard)
   vehicle capacity                       (soft, rarely binding)
```

`cost_of_failed_attempt` is not $9.75. It is the REPRISE price **plus** a second custody exposure
window plus a notification cycle plus the recipient's goodwill. Price it properly or the optimiser
treats a missed door as a rounding error.

Start with `λ_late` high enough that a promised window is effectively inviolable, and tune down only
with evidence.

---

## 7.2 Feeds

| Feed | Use | Notes |
|---|---|---|
| Google Routes / Mapbox / HERE | traffic-aware travel-time matrices, ETAs | commodity; wrap behind one interface so it is swappable |
| **Québec 511 (MTQ)** | closures, construction, incidents | the local edge |
| **Montréal open data** | street closures, permits | ditto |
| Environment Canada | weather | freezing rain changes dwell time *and* risk |

```ts
interface TrafficProvider {
  matrix(origins: LatLng[], destinations: LatLng[], departAt: Date): Promise<Duration[][]>;
  route(stops: LatLng[], departAt: Date): Promise<{ legs: Leg[]; polyline: string }>;
}
```

Cone season is a permanent, structural Québec condition that no national vendor tunes for, and it is
the largest source of route decay between May and November. Ingesting 511 and Montréal closures is a
few days of work and it is the part of this system a competitor cannot copy by buying a licence.

---

## 7.3 What the model learns from our own data

None of this can be bought. All of it comes out of `route_stop.dwell_seconds` and `driver_ping`.

| Signal | Feature | Effect |
|---|---|---|
| Dwell by building type | duplex walk-up · condo with concierge · strip-mall storefront · office | the single largest source of drift; a global average is why static routes fall apart by mid-morning |
| Parking difficulty | by street segment × hour, from GPS dwell minus door time | invisible to every commercial optimiser; measurable directly from our own pings |
| `p_absent` | by hour × day-of-week × recipient history | drives the pre-dispatch reschedule offer |
| Travel-time residual | our actual vs the provider's predicted | a per-corridor correction factor |
| Insertion cost | marginal delay of adding an add-on to a live route | gates whether an offer is shown to that driver at all |

**Model v1 is not machine learning.** It is a hierarchical mean with shrinkage: dwell by
`(building_type, hour)` backing off to `(building_type)` backing off to a global prior. That beats a
traffic API on its own and it is auditable, which matters when a driver asks why they were re-routed.
Consider gradient boosting only after two seasons of data.

```ts
// packages/api/src/routing/dwell.ts
export function predictDwell(f: StopFeatures): Seconds {
  const cells = [key(f.building_type, f.hour), key(f.building_type), 'GLOBAL'];
  let num = 0, den = 0;
  for (const c of cells) {                       // James–Stein style shrinkage
    const s = stats.get(c); if (!s) continue;
    const w = s.n / (s.n + PRIOR_STRENGTH);
    num += w * s.mean * (1 - den); den += w * (1 - den);
    if (den > 0.98) break;
  }
  return Math.round(num + (1 - den) * GLOBAL_PRIOR);
}
```

---

## 7.4 When it runs

**Event-triggered, never on a timer.** Travel-time matrix calls scale with the square of the stop
count; a naïve "re-optimise every 60 seconds" loop produces a routing bill larger than a driver's day
rate.

Triggers:

- A traffic incident or closure on a leg **we have actually planned**.
- A new booking or add-on offer that might be inserted.
- An exception raised.
- A driver idle > 10 minutes at a stop that predicted 4.
- ETA drift > 12 minutes against a promised window.

Plus one scheduled plan at 06:00 for the day, and a hard daily spend cap per route.

```sql
CREATE TABLE custode.routing_spend (
  service_date date PRIMARY KEY,
  matrix_calls integer NOT NULL DEFAULT 0,
  cost_cents   integer NOT NULL DEFAULT 0,
  capped_at    timestamptz
);
```

When the cap is hit the router degrades to static ETAs and **logs that it did**. Silent degradation of
a safety-adjacent system is worse than the degradation.

---

## 7.5 Guardrails

Custody makes this different from food delivery.

| Guardrail | Rule |
|---|---|
| **Every re-route is chained** | `route.resequenced { from_seq, to_seq, reason, saved_seconds }`. If a phone spent forty extra minutes in a car, the reason is in the record. An optimiser that silently reorders the day is an unexplained gap in the chain, and the chain is the product. |
| **Never silently re-sequence a device in custody** | Any re-sequence that increases exposure on a `PICKED_UP` movement requires dispatcher approval. Before pickup the router is free. |
| **Threshold, or drivers tune it out** | Surface a change only when the saving beats `RESEQUENCE_MIN_SAVING = 8 min`. Constant "recalculating" is how good advice gets ignored. |
| **One line of explanation, always** | *"Moved ahead of stop 4 — A-40 closed at Décarie."* A driver who understands the change follows it; one who does not drives the old order anyway. |
| **Router and off-route alarm read the same plan** | If routing sends a driver a way the geofence system flags as off-route, the two systems fight and the alarm becomes noise. Same `route_version` on both sides. |
| **Never break a sold SLA silently** | An AM commitment at $21.50 is a promise. Trading against it requires a dispatcher in the loop. |
| **No decision about a person** | The router never selects, ranks or penalises a driver or a recipient. It orders stops. Documented for Law 25 automated-decision transparency. |

---

## 7.6 Off-route detection

Separate from optimisation, and simpler on purpose.

```ts
const DEFAULT_OFFROUTE_KM = 2;        // per-provider configurable: 1 | 2 | 5
```

A driver is off-route when their position is more than the threshold from the planned polyline **and**
they have been for two consecutive pings **and** they are `PICKED_UP` on at least one movement. Chains
`route.offroute`, alerts dispatch, and never blocks anything by itself — it is a signal, not a gate.

---

## 7.7 Recipient ETA

The tracker shows a window that narrows honestly as the day resolves:

| Phase | Window |
|---|---|
| Booked | the sold service window (e.g. "by 10:30") |
| Route planned (06:00) | ±90 minutes |
| Driver en route on the leg before | ±30 minutes |
| Driver approaching (< 10 min or < 2 stops) | "arriving in about 8 minutes" + the OTP |

Never show a point estimate earlier than the last row. A four-hour window wastes the recipient's day,
and a false five-minute promise costs a failed attempt — which, per §7.1, is the expensive outcome.

---

## 7.8 Build order

1. **Traffic-aware ETAs from one provider.** No ML at all. Feeds the tracker's narrowing window. Days
   of work, and most of the perceived value.
2. **Log `dwell_seconds` and `travel_seconds` on every stop.** Free, invisible, and impossible to
   backfill. Ship it in the same week as step 1.
3. **Event-triggered re-sequencing on the exposure objective.** Requires the dispatch board and the
   reassign path from §3.9 to exist first.
4. **Learned dwell, parking and `p_absent`.** After a season of our own data. This is where the route
   stops drifting by mid-morning.
