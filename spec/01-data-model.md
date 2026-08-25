# 1. Data model

Postgres 16 on Azure Database for PostgreSQL — Flexible Server. Migrations are numbered and
forward-only; there are no down migrations, because the ledger tables must never be rolled back.

Two schemas:

- `custode` — operational data.
- `pii` — personal data that must be purgeable independently of the ledger. Separate schema so
  the purge job's blast radius is a schema, not a grep.

---

## 1.1 Identity and tenancy

```sql
CREATE TABLE custode.provider (
  id              text PRIMARY KEY,                    -- prv_...
  name            text NOT NULL,
  legal_name      text NOT NULL,
  status          text NOT NULL DEFAULT 'ACTIVE'
                  CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
  declared_cap_cents  integer NOT NULL DEFAULT 1000000, -- per-box ceiling, follows the policy
  insurance_expires_on date,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE custode.store (
  id              text PRIMARY KEY,                    -- str_...
  provider_id     text NOT NULL REFERENCES custode.provider(id),
  name            text NOT NULL,
  address_line1   text NOT NULL,
  address_city    text NOT NULL,
  address_postal  text NOT NULL,
  lat             numeric(9,6),
  lng             numeric(9,6),
  timezone        text NOT NULL DEFAULT 'America/Toronto',
  cutoff_local    time NOT NULL DEFAULT '16:00',       -- after this, AM/NOON are next business day
  status          text NOT NULL DEFAULT 'ACTIVE',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON custode.store (provider_id);

CREATE TABLE custode.app_user (
  id              text PRIMARY KEY,                    -- usr_...
  role            text NOT NULL CHECK (role IN
                    ('SUPER_ADMIN','DISPATCHER','DRIVER',
                     'PROVIDER_ADMIN','STORE_MANAGER','STORE_REP')),
  provider_id     text REFERENCES custode.provider(id),
  store_id        text REFERENCES custode.store(id),
  display_name    text NOT NULL,
  email           citext UNIQUE,
  phone_e164      text UNIQUE,
  locale          text NOT NULL DEFAULT 'fr-CA' CHECK (locale IN ('fr-CA','en-CA')),
  status          text NOT NULL DEFAULT 'ACTIVE'
                  CHECK (status IN ('INVITED','ACTIVE','SUSPENDED','CLOSED')),
  last_seen_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- a store role must be scoped to exactly one store; CUSTODE roles to none
  CONSTRAINT scope_shape CHECK (
    (role IN ('STORE_MANAGER','STORE_REP') AND store_id IS NOT NULL AND provider_id IS NOT NULL)
    OR (role = 'PROVIDER_ADMIN' AND provider_id IS NOT NULL AND store_id IS NULL)
    OR (role IN ('SUPER_ADMIN','DISPATCHER','DRIVER') AND provider_id IS NULL AND store_id IS NULL)
  )
);
CREATE INDEX ON custode.app_user (store_id) WHERE store_id IS NOT NULL;
```

`STORE_MANAGER` rows are created only by a `SUPER_ADMIN`. Enforce with a trigger, not only in
application code — a provider that can promote its own users defeats unseal dual control.

```sql
CREATE TABLE custode.driver (
  id                  text PRIMARY KEY,                -- drv_...
  user_id             text NOT NULL UNIQUE REFERENCES custode.app_user(id),
  status              text NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','ACTIVE','SUSPENDED','OFFBOARDED')),
  online              boolean NOT NULL DEFAULT false,
  vehicle_desc        text,
  licence_expires_on  date,
  insurance_expires_on date,
  background_check_on date,
  sop_signed_at       timestamptz,
  onboarding_complete boolean GENERATED ALWAYS AS (
    licence_expires_on IS NOT NULL AND insurance_expires_on IS NOT NULL
    AND background_check_on IS NOT NULL AND sop_signed_at IS NOT NULL) STORED
);
```

A driver MUST NOT be offered a movement unless `status='ACTIVE' AND onboarding_complete AND
licence_expires_on > current_date AND insurance_expires_on > current_date`. This is the underwriter's
file expressed as a query.

---

## 1.2 Catalogue and item types

```sql
CREATE TABLE custode.item_type (
  code        text PRIMARY KEY,        -- IMEI, SERIAL, ICCID, SKU, UNKNOWN
  serialized  boolean NOT NULL,        -- unique identity; qty always 1
  validator   text                     -- 'luhn15' | 'iccid' | null
);
INSERT INTO custode.item_type VALUES
  ('IMEI',    true,  'luhn15'),
  ('SERIAL',  true,  null),
  ('ICCID',   true,  'iccid'),
  ('SKU',     false, null),
  ('UNKNOWN', false, null);

CREATE TABLE custode.catalogue_item (
  provider_id   text NOT NULL REFERENCES custode.provider(id),
  code          text NOT NULL,                 -- the barcode as scanned
  item_type     text NOT NULL REFERENCES custode.item_type(code),
  label_fr      text NOT NULL,
  label_en      text NOT NULL,
  value_cents   integer NOT NULL DEFAULT 0,
  active        boolean NOT NULL DEFAULT true,
  PRIMARY KEY (provider_id, code)
);
```

**Luhn is selected by `item_type.validator`, never applied globally.** A charger's UPC will fail Luhn.
The current `POST /manifests` behaviour of rejecting every non-Luhn entry is a defect to be removed.

---

## 1.3 Seals

```sql
CREATE TABLE custode.seal (
  id            text PRIMARY KEY,                      -- seal_...
  seal_no       text NOT NULL UNIQUE,                  -- CS-#####
  range_id      text NOT NULL REFERENCES custode.seal_range(id),
  issued_to_store text REFERENCES custode.store(id),
  status        text NOT NULL DEFAULT 'ISSUED'
                CHECK (status IN ('ISSUED','APPLIED','VOIDED','CLOSED')),
  applied_at    timestamptz,
  voided_at     timestamptz,
  void_reason   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE custode.seal_range (
  id          text PRIMARY KEY,
  prefix      text NOT NULL,
  first_no    integer NOT NULL,
  last_no     integer NOT NULL,
  store_id    text REFERENCES custode.store(id),
  issued_at   timestamptz NOT NULL DEFAULT now()
);
```

Rules:

- A seal number MUST come from a range issued to that store. An out-of-range number is rejected at
  seal time and raises an anomaly.
- `VOIDED` is terminal. A voided seal MUST NOT be reusable — enforce with the unique constraint plus
  a status check at seal time.
- `CLOSED` means the recipient legitimately opened it at delivery. Distinct from `VOIDED`.

---

## 1.4 Box and manifest

```sql
CREATE TABLE custode.box (
  id              text PRIMARY KEY,                    -- box_...
  box_ref         text NOT NULL UNIQUE,                -- BX-####
  store_id        text NOT NULL REFERENCES custode.store(id),
  ticket_id       text REFERENCES custode.ticket(id),
  status          text NOT NULL DEFAULT 'OPEN'
                  CHECK (status IN ('OPEN','SEALED','IN_CUSTODY','RELEASED','ABANDONED')),
  current_seal_id text REFERENCES custode.seal(id),
  seal_count      integer NOT NULL DEFAULT 0,          -- >1 means it was re-sealed
  packed_by       text REFERENCES custode.app_user(id),
  sealed_at       timestamptz,
  declared_cents  integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE custode.manifest_line (
  id            text PRIMARY KEY,
  box_id        text NOT NULL REFERENCES custode.box(id),
  code          text NOT NULL,
  item_type     text NOT NULL REFERENCES custode.item_type(code),
  label         text NOT NULL,                         -- resolved at scan time, frozen
  qty           integer NOT NULL DEFAULT 1 CHECK (qty > 0),
  value_cents   integer NOT NULL DEFAULT 0,
  expected      boolean,                               -- null until a ticket is attached
  scanned_by    text NOT NULL REFERENCES custode.app_user(id),
  scanned_at    timestamptz NOT NULL DEFAULT now(),
  photo_blob_id text,                                  -- required when item_type='UNKNOWN'
  UNIQUE (box_id, code)
);
```

Constraints enforced in the API layer, not expressible in DDL:

1. A serialized `code` MUST NOT appear on two boxes with an open movement. Rescanning it into the
   same box is rejected with `409 duplicate_serialized_item`.
2. A non-serialized `code` rescanned increments `qty`. This is normal and MUST NOT warn.
3. `item_type='UNKNOWN'` requires `photo_blob_id`.
4. Once `box.status='SEALED'`, `manifest_line` is immutable. Any write returns `409 manifest_locked`.

```sql
-- freeze the manifest at seal
CREATE FUNCTION custode.manifest_guard() RETURNS trigger AS $$
BEGIN
  IF (SELECT status FROM custode.box WHERE id = COALESCE(NEW.box_id, OLD.box_id)) <> 'OPEN' THEN
    RAISE EXCEPTION 'manifest_locked';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;

CREATE TRIGGER manifest_guard
  BEFORE INSERT OR UPDATE OR DELETE ON custode.manifest_line
  FOR EACH ROW EXECUTE FUNCTION custode.manifest_guard();
```

---

## 1.5 Ticket and recipient

```sql
CREATE TABLE custode.ticket (
  id            text PRIMARY KEY,                      -- tkt_...
  provider_id   text NOT NULL REFERENCES custode.provider(id),
  store_id      text NOT NULL REFERENCES custode.store(id),
  external_ref  text NOT NULL,                         -- THEIR number: BM-1042
  source        text NOT NULL
                CHECK (source IN ('API','FILE_DROP','SCANNED','MANUAL')),
  fetched_at    timestamptz,
  raw_payload   jsonb,                                 -- what their system returned, verbatim
  UNIQUE (provider_id, external_ref)
);

CREATE TABLE custode.ticket_expected_line (
  ticket_id   text NOT NULL REFERENCES custode.ticket(id),
  code        text NOT NULL,
  qty         integer NOT NULL DEFAULT 1,
  PRIMARY KEY (ticket_id, code)
);
```

`source` matters commercially: it records which rung of the integration ladder this provider is on,
and `SCANNED` is the week-one default. See §5.

### Recipient PII lives in its own schema

```sql
CREATE TABLE pii.recipient (
  id            text PRIMARY KEY,                      -- rcp_...
  full_name     text NOT NULL,
  phone_e164    text,
  email         citext,
  locale        text NOT NULL DEFAULT 'fr-CA',
  purged_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pii.address (
  id            text PRIMARY KEY,                      -- adr_...
  unit          text,
  line1         text NOT NULL,
  city          text NOT NULL,
  province      text NOT NULL DEFAULT 'QC',
  postal        text NOT NULL,
  note          text,
  lat           numeric(9,6),
  lng           numeric(9,6),
  purged_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

`custode.movement` references these by id and **also stores a hash** of the canonical address string.
The hash goes in the ledger; the plaintext can be purged without breaking a single chain link. See §2.4.

---

## 1.6 Movement

```sql
CREATE TABLE custode.movement (
  id                  text PRIMARY KEY,                -- mov_...
  movement_ref        text NOT NULL UNIQUE,            -- M-####
  provider_id         text NOT NULL REFERENCES custode.provider(id),
  store_id            text NOT NULL REFERENCES custode.store(id),
  box_id              text NOT NULL REFERENCES custode.box(id),
  ticket_id           text REFERENCES custode.ticket(id),
  parent_movement_id  text REFERENCES custode.movement(id),  -- set on a REPRISE

  service_code        text NOT NULL REFERENCES custode.service(code),
  price_cents         integer NOT NULL,
  declared_cents      integer NOT NULL,

  status              text NOT NULL DEFAULT 'BOOKED' CHECK (status IN
                      ('BOOKED','OFFERED','ASSIGNED','PICKED_UP','DELIVERED',
                       'EXCEPTION','CANCELLED','RECALLED')),

  driver_id           text REFERENCES custode.driver(id),
  recipient_id        text NOT NULL,                   -- pii.recipient
  address_id          text NOT NULL,                   -- pii.address, as shipped
  address_fetched_id  text,                            -- pii.address, as fetched from the CRM
  address_hash        text NOT NULL,                   -- sha256 of the canonical shipped address
  address_overridden  boolean NOT NULL DEFAULT false,
  address_confirmed_by text REFERENCES custode.app_user(id),
  address_confirmed_at timestamptz,

  promised_from       timestamptz,
  promised_to         timestamptz,
  booked_at           timestamptz NOT NULL DEFAULT now(),
  free_cancel_until   timestamptz NOT NULL,
  picked_up_at        timestamptz,
  delivered_at        timestamptz,
  closed_at           timestamptz,

  exception_code      text,
  cancel_fee_cents    integer
);
CREATE INDEX ON custode.movement (status) WHERE status IN ('BOOKED','OFFERED','ASSIGNED','PICKED_UP');
CREATE INDEX ON custode.movement (driver_id, status);
CREATE INDEX ON custode.movement (provider_id, booked_at DESC);
```

`address_confirmed_at` is `NOT NULL` before a box may be sealed. See §3.3.

```sql
CREATE TABLE custode.address_override (
  id            text PRIMARY KEY,
  movement_id   text NOT NULL REFERENCES custode.movement(id),
  fields        text[] NOT NULL,                       -- which fields changed
  material      boolean NOT NULL,                      -- line1 | city | postal
  reason        text,                                  -- required when material
  changed_by    text NOT NULL REFERENCES custode.app_user(id),
  approved_by   text REFERENCES custode.app_user(id),  -- required above the threshold
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON custode.address_override (created_at DESC) WHERE material;
```

That partial index is the admin review queue. It is small and very high signal — material redirects
are where insider fraud surfaces first.

---

## 1.7 Handover proofs

```sql
CREATE TABLE custode.otp (
  id            text PRIMARY KEY,
  movement_id   text NOT NULL REFERENCES custode.movement(id),
  purpose       text NOT NULL CHECK (purpose IN ('PICKUP','DELIVERY','UNSEAL')),
  code_hash     text NOT NULL,                         -- argon2id. Never store the code.
  expires_at    timestamptz NOT NULL,
  attempts      integer NOT NULL DEFAULT 0,
  consumed_at   timestamptz,
  sent_to       text NOT NULL,                         -- masked destination, for display
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE custode.signature (
  id            text PRIMARY KEY,
  movement_id   text NOT NULL REFERENCES custode.movement(id),
  purpose       text NOT NULL CHECK (purpose IN ('PICKUP','DELIVERY')),
  signer_name   text NOT NULL,
  blob_id       text NOT NULL,                         -- PNG in blob storage
  captured_at   timestamptz NOT NULL DEFAULT now(),
  lat           numeric(9,6) NOT NULL,
  lng           numeric(9,6) NOT NULL,
  accuracy_m    numeric(6,1) NOT NULL
);

CREATE TABLE custode.proof_photo (
  id            text PRIMARY KEY,
  movement_id   text NOT NULL REFERENCES custode.movement(id),
  kind          text NOT NULL CHECK (kind IN
                ('SEAL_AT_PICKUP','SEAL_AT_DOOR','PACKAGE_AT_DOOR','REFUSAL','EXCEPTION','UNKNOWN_ITEM')),
  blob_id       text NOT NULL,
  lat           numeric(9,6), lng numeric(9,6),
  captured_at   timestamptz NOT NULL
);
```

Both `SEAL_AT_PICKUP` and `SEAL_AT_DOOR` are required for a movement to reach `DELIVERED`. That pair
of photos, of the same seal number, timestamped and geofenced, is the evidence the whole product rests
on.

---

## 1.8 Position and route

```sql
CREATE TABLE custode.driver_ping (
  driver_id     text NOT NULL REFERENCES custode.driver(id),
  at            timestamptz NOT NULL,
  lat           numeric(9,6) NOT NULL,
  lng           numeric(9,6) NOT NULL,
  accuracy_m    numeric(6,1),
  speed_mps     numeric(6,2),
  mocked        boolean NOT NULL DEFAULT false,        -- OS mock-location flag
  battery_pct   smallint,
  PRIMARY KEY (driver_id, at)
) PARTITION BY RANGE (at);

CREATE TABLE custode.route (
  id            text PRIMARY KEY,
  driver_id     text NOT NULL REFERENCES custode.driver(id),
  service_date  date NOT NULL,
  status        text NOT NULL DEFAULT 'PLANNED'
                CHECK (status IN ('PLANNED','OFFERED','ACCEPTED','ACTIVE','CLOSED')),
  UNIQUE (driver_id, service_date)
);

CREATE TABLE custode.route_stop (
  id            text PRIMARY KEY,
  route_id      text NOT NULL REFERENCES custode.route(id),
  movement_id   text NOT NULL REFERENCES custode.movement(id),
  kind          text NOT NULL CHECK (kind IN ('PICKUP','DELIVER')),
  seq           integer NOT NULL,
  eta           timestamptz,
  arrived_at    timestamptz,
  departed_at   timestamptz,
  dwell_seconds integer,                               -- measured, feeds the model in §7
  travel_seconds integer,
  UNIQUE (route_id, seq)
);
```

`dwell_seconds` and `travel_seconds` cost nothing to record and cannot be backfilled. Populate them
from day one — §7 is worthless without a season of this data.

---

## 1.9 Commercial

```sql
CREATE TABLE custode.service (
  code          text PRIMARY KEY,
  name          text NOT NULL,
  window_label  text NOT NULL,
  price_cents   integer NOT NULL,
  morning_only  boolean NOT NULL DEFAULT false,
  active        boolean NOT NULL DEFAULT true,
  sort_order    integer NOT NULL
);
INSERT INTO custode.service VALUES
  ('CUSTODE_24',      'CUSTODE 24',      'end of day',   1075, false, true, 1),
  ('CUSTODE_24_NOON', 'CUSTODE 24 NOON', 'by 12:00',     1550, true,  true, 2),
  ('CUSTODE_24_AM',   'CUSTODE 24 AM',   'by 10:30',     2150, true,  true, 3),
  ('CUSTODE_EVENING', 'CUSTODE EVENING', '17:30–21:00',  2350, false, true, 4),
  ('REPRISE',         'REPRISE',         'reverse pickup', 975, false, true, 5);
```

`CUSTODE_24` is the default selection in every booking UI. The rate card is editable by
`SUPER_ADMIN` through the admin console — a price change MUST NOT require a deploy.

```sql
CREATE TABLE custode.claim (
  id            text PRIMARY KEY,
  movement_id   text NOT NULL REFERENCES custode.movement(id),
  opened_by     text NOT NULL REFERENCES custode.app_user(id),
  kind          text NOT NULL CHECK (kind IN
                ('SHORTAGE','WRONG_ITEM','DAMAGE','LOSS','SEAL_COMPROMISED','LATE')),
  amount_cents  integer,
  status        text NOT NULL DEFAULT 'OPEN'
                CHECK (status IN ('OPEN','INVESTIGATING','ACCEPTED','DECLINED','WITHDRAWN')),
  binding       text CHECK (binding IN ('ITEMS_TO_BOX','BOX_TO_RECIPIENT')),  -- who owns it
  narrative     text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz
);
```

`binding` forces the triage in §0.1 to be recorded as a decision. `ITEMS_TO_BOX` claims are the
provider's picking error, evidenced by their own scans; `BOX_TO_RECIPIENT` claims are ours.

---

## 1.10 Retention summary

| Data | Retention | Mechanism |
|---|---|---|
| Ledger events | **7 years**, never deleted | append-only, no `DELETE` grant |
| Manifest lines | 7 years | ditto |
| `pii.recipient`, `pii.address` | 24 months after `closed_at`, or on request | nightly purge job sets `purged_at`, nulls fields |
| Signatures & proof photos | 7 years | blob storage, immutable tier |
| `driver_ping` | 90 days at full resolution, then downsampled to one ping/minute for 7 years | partition drop + rollup |
| Webhook delivery logs | 30 days | partition drop |

Seven years is a deliberate sales position: FedEx eCOC archives five, Detrack five, Onfleet Enterprise
lifetime. Put the number in the terms of carriage and on the rate sheet.
