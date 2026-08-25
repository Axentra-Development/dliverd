-- CUSTODE 0001 — initial schema.
-- Forward-only. There is no down migration: the ledger must never be rolled back.
--
-- Two schemas by design (spec §1):
--   custode  operational data
--   pii      personal data, purgeable independently of the ledger

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;

CREATE SCHEMA IF NOT EXISTS custode;
CREATE SCHEMA IF NOT EXISTS pii;

-- ===========================================================================
-- Identity and tenancy
-- ===========================================================================

CREATE TABLE custode.provider (
  id                  text PRIMARY KEY,
  name                text NOT NULL,
  legal_name          text NOT NULL,
  status              text NOT NULL DEFAULT 'ACTIVE'
                      CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
  declared_cap_cents  integer NOT NULL DEFAULT 1000000,
  insurance_expires_on date,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE custode.store (
  id              text PRIMARY KEY,
  provider_id     text NOT NULL REFERENCES custode.provider(id),
  name            text NOT NULL,
  address_line1   text NOT NULL,
  address_city    text NOT NULL,
  address_postal  text NOT NULL,
  lat             numeric(9,6),
  lng             numeric(9,6),
  timezone        text NOT NULL DEFAULT 'America/Toronto',
  cutoff_local    time NOT NULL DEFAULT '16:00',
  status          text NOT NULL DEFAULT 'ACTIVE'
                  CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX store_provider_idx ON custode.store (provider_id);

CREATE TABLE custode.app_user (
  id            text PRIMARY KEY,
  role          text NOT NULL CHECK (role IN
                ('SUPER_ADMIN','DISPATCHER','DRIVER','PROVIDER_ADMIN','STORE_MANAGER','STORE_REP')),
  provider_id   text REFERENCES custode.provider(id),
  store_id      text REFERENCES custode.store(id),
  display_name  text NOT NULL,
  email         citext UNIQUE,
  phone_e164    text UNIQUE,
  locale        text NOT NULL DEFAULT 'fr-CA' CHECK (locale IN ('fr-CA','en-CA')),
  status        text NOT NULL DEFAULT 'ACTIVE'
                CHECK (status IN ('INVITED','ACTIVE','SUSPENDED','CLOSED')),
  external_idp_subject text UNIQUE,          -- reserved for Entra ID federation (§6.3)
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scope_shape CHECK (
       (role IN ('STORE_MANAGER','STORE_REP') AND store_id IS NOT NULL AND provider_id IS NOT NULL)
    OR (role = 'PROVIDER_ADMIN' AND provider_id IS NOT NULL AND store_id IS NULL)
    OR (role IN ('SUPER_ADMIN','DISPATCHER','DRIVER') AND provider_id IS NULL AND store_id IS NULL)
  )
);
CREATE INDEX app_user_store_idx ON custode.app_user (store_id) WHERE store_id IS NOT NULL;

-- A provider must not be able to promote its own users to STORE_MANAGER, or a
-- rep promotes themselves and unseal dual control collapses (§0.5, §6.1).
CREATE TABLE custode.role_grant_audit (
  id          bigserial PRIMARY KEY,
  user_id     text NOT NULL,
  from_role   text,
  to_role     text NOT NULL,
  granted_by  text NOT NULL,
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION custode.guard_manager_grant() RETURNS trigger AS $$
DECLARE actor_role text;
BEGIN
  IF NEW.role = 'STORE_MANAGER' AND (TG_OP = 'INSERT' OR OLD.role IS DISTINCT FROM 'STORE_MANAGER') THEN
    actor_role := current_setting('custode.actor_role', true);
    IF actor_role IS DISTINCT FROM 'SUPER_ADMIN' THEN
      RAISE EXCEPTION 'store_manager_requires_super_admin';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER guard_manager_grant
  BEFORE INSERT OR UPDATE OF role ON custode.app_user
  FOR EACH ROW EXECUTE FUNCTION custode.guard_manager_grant();

-- ===========================================================================
-- Catalogue and item types
-- ===========================================================================

CREATE TABLE custode.item_type (
  code        text PRIMARY KEY,
  serialized  boolean NOT NULL,
  validator   text
);
INSERT INTO custode.item_type (code, serialized, validator) VALUES
  ('IMEI',    true,  'luhn15'),
  ('SERIAL',  true,  NULL),
  ('ICCID',   true,  'iccid'),
  ('SKU',     false, NULL),
  ('UNKNOWN', false, NULL);

CREATE TABLE custode.catalogue_item (
  provider_id  text NOT NULL REFERENCES custode.provider(id),
  code         text NOT NULL,
  item_type    text NOT NULL REFERENCES custode.item_type(code),
  label_fr     text NOT NULL,
  label_en     text NOT NULL,
  value_cents  integer NOT NULL DEFAULT 0,
  active       boolean NOT NULL DEFAULT true,
  PRIMARY KEY (provider_id, code)
);

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
  ('CUSTODE_24',      'CUSTODE 24',      'end of day',     1075, false, true, 1),
  ('CUSTODE_24_NOON', 'CUSTODE 24 NOON', 'by 12:00',       1550, true,  true, 2),
  ('CUSTODE_24_AM',   'CUSTODE 24 AM',   'by 10:30',       2150, true,  true, 3),
  ('CUSTODE_EVENING', 'CUSTODE EVENING', '17:30-21:00',    2350, false, true, 4),
  ('REPRISE',         'REPRISE',         'reverse pickup',  975, false, true, 5);

-- ===========================================================================
-- Seals
-- ===========================================================================

CREATE TABLE custode.seal_range (
  id        text PRIMARY KEY,
  prefix    text NOT NULL,
  first_no  integer NOT NULL,
  last_no   integer NOT NULL,
  store_id  text REFERENCES custode.store(id),
  issued_at timestamptz NOT NULL DEFAULT now(),
  CHECK (last_no >= first_no)
);

CREATE TABLE custode.seal (
  id              text PRIMARY KEY,
  seal_no         text NOT NULL UNIQUE,
  range_id        text NOT NULL REFERENCES custode.seal_range(id),
  issued_to_store text REFERENCES custode.store(id),
  status          text NOT NULL DEFAULT 'ISSUED'
                  CHECK (status IN ('ISSUED','APPLIED','VOIDED','CLOSED')),
  applied_at      timestamptz,
  voided_at       timestamptz,
  void_reason     text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- VOIDED is terminal. A voided seal can never be reapplied (§3.1).
CREATE FUNCTION custode.guard_seal_status() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'VOIDED' AND NEW.status <> 'VOIDED' THEN
    RAISE EXCEPTION 'seal_voided_is_terminal';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER guard_seal_status BEFORE UPDATE ON custode.seal
  FOR EACH ROW EXECUTE FUNCTION custode.guard_seal_status();

-- ===========================================================================
-- Tickets
-- ===========================================================================

CREATE TABLE custode.ticket (
  id            text PRIMARY KEY,
  provider_id   text NOT NULL REFERENCES custode.provider(id),
  store_id      text NOT NULL REFERENCES custode.store(id),
  external_ref  text NOT NULL,
  source        text NOT NULL CHECK (source IN ('API','FILE_DROP','SCANNED','MANUAL')),
  fetched_at    timestamptz,
  raw_payload   jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, external_ref)
);

CREATE TABLE custode.ticket_expected_line (
  ticket_id text NOT NULL REFERENCES custode.ticket(id),
  code      text NOT NULL,
  qty       integer NOT NULL DEFAULT 1 CHECK (qty > 0),
  PRIMARY KEY (ticket_id, code)
);

-- ===========================================================================
-- Personal data — separate schema so the purge job's blast radius is a schema
-- ===========================================================================

CREATE TABLE pii.recipient (
  id          text PRIMARY KEY,
  full_name   text,
  phone_e164  text,
  email       citext,
  locale      text NOT NULL DEFAULT 'fr-CA' CHECK (locale IN ('fr-CA','en-CA')),
  purged_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pii.address (
  id          text PRIMARY KEY,
  unit        text,
  line1       text,
  city        text,
  province    text NOT NULL DEFAULT 'QC',
  postal      text,
  note        text,
  lat         numeric(9,6),
  lng         numeric(9,6),
  -- Stored WITH the plaintext: purging the address also destroys the ability to
  -- brute-force it back from the ledger hash (§2.4).
  hash_salt   text NOT NULL,
  purged_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ===========================================================================
-- Box and manifest
-- ===========================================================================

CREATE TABLE custode.box (
  id              text PRIMARY KEY,
  box_ref         text NOT NULL UNIQUE,
  store_id        text NOT NULL REFERENCES custode.store(id),
  ticket_id       text REFERENCES custode.ticket(id),
  status          text NOT NULL DEFAULT 'OPEN'
                  CHECK (status IN ('OPEN','SEALED','IN_CUSTODY','RELEASED','ABANDONED')),
  current_seal_id text REFERENCES custode.seal(id),
  seal_count      integer NOT NULL DEFAULT 0,
  packed_by       text REFERENCES custode.app_user(id),
  sealed_at       timestamptz,
  declared_cents  integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX box_store_idx ON custode.box (store_id, created_at DESC);

CREATE TABLE custode.manifest_line (
  id            text PRIMARY KEY,
  box_id        text NOT NULL REFERENCES custode.box(id),
  code          text NOT NULL,
  item_type     text NOT NULL REFERENCES custode.item_type(code),
  label         text NOT NULL,
  qty           integer NOT NULL DEFAULT 1 CHECK (qty > 0),
  value_cents   integer NOT NULL DEFAULT 0,
  expected      boolean,
  scanned_by    text NOT NULL REFERENCES custode.app_user(id),
  scanned_at    timestamptz NOT NULL DEFAULT now(),
  photo_blob_id text,
  UNIQUE (box_id, code),
  -- an unidentified item must carry a photo (§1.4)
  CONSTRAINT unknown_needs_photo CHECK (item_type <> 'UNKNOWN' OR photo_blob_id IS NOT NULL),
  -- a serialized item is always quantity 1
  CONSTRAINT serialized_qty CHECK (item_type NOT IN ('IMEI','SERIAL','ICCID') OR qty = 1)
);

-- The manifest freezes at seal. Any write after that is refused (§1.4).
CREATE FUNCTION custode.manifest_guard() RETURNS trigger AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM custode.box WHERE id = COALESCE(NEW.box_id, OLD.box_id);
  IF st IS DISTINCT FROM 'OPEN' THEN
    RAISE EXCEPTION 'manifest_locked';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;

CREATE TRIGGER manifest_guard
  BEFORE INSERT OR UPDATE OR DELETE ON custode.manifest_line
  FOR EACH ROW EXECUTE FUNCTION custode.manifest_guard();

-- ===========================================================================
-- Movement
-- ===========================================================================

CREATE TABLE custode.movement (
  id                   text PRIMARY KEY,
  movement_ref         text NOT NULL UNIQUE,
  provider_id          text NOT NULL REFERENCES custode.provider(id),
  store_id             text NOT NULL REFERENCES custode.store(id),
  box_id               text NOT NULL REFERENCES custode.box(id),
  ticket_id            text REFERENCES custode.ticket(id),
  parent_movement_id   text REFERENCES custode.movement(id),
  service_code         text NOT NULL REFERENCES custode.service(code),
  price_cents          integer NOT NULL,
  declared_cents       integer NOT NULL DEFAULT 0,
  status               text NOT NULL DEFAULT 'BOOKED' CHECK (status IN
                       ('BOOKED','OFFERED','ASSIGNED','PICKED_UP','DELIVERED',
                        'EXCEPTION','CANCELLED','RECALLED')),
  driver_user_id       text REFERENCES custode.app_user(id),
  recipient_id         text NOT NULL REFERENCES pii.recipient(id),
  address_id           text NOT NULL REFERENCES pii.address(id),
  address_fetched_id   text REFERENCES pii.address(id),
  address_hash         text NOT NULL,
  address_overridden   boolean NOT NULL DEFAULT false,
  address_confirmed_by text REFERENCES custode.app_user(id),
  address_confirmed_at timestamptz,
  promised_from        timestamptz,
  promised_to          timestamptz,
  booked_at            timestamptz NOT NULL DEFAULT now(),
  free_cancel_until    timestamptz NOT NULL,
  picked_up_at         timestamptz,
  delivered_at         timestamptz,
  closed_at            timestamptz,
  exception_code       text,
  cancel_fee_cents     integer
);
CREATE INDEX movement_open_idx ON custode.movement (status)
  WHERE status IN ('BOOKED','OFFERED','ASSIGNED','PICKED_UP','EXCEPTION');
CREATE INDEX movement_driver_idx ON custode.movement (driver_user_id, status);
CREATE INDEX movement_provider_idx ON custode.movement (provider_id, booked_at DESC);

-- address_fetched_id is written once and never updated (§3.4).
CREATE FUNCTION custode.guard_address_fetched() RETURNS trigger AS $$
BEGIN
  IF OLD.address_fetched_id IS NOT NULL
     AND NEW.address_fetched_id IS DISTINCT FROM OLD.address_fetched_id THEN
    RAISE EXCEPTION 'address_fetched_is_immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER guard_address_fetched BEFORE UPDATE ON custode.movement
  FOR EACH ROW EXECUTE FUNCTION custode.guard_address_fetched();

CREATE TABLE custode.address_override (
  id           text PRIMARY KEY,
  movement_id  text NOT NULL REFERENCES custode.movement(id),
  fields       text[] NOT NULL,
  material     boolean NOT NULL,
  reason       text,
  changed_by   text NOT NULL REFERENCES custode.app_user(id),
  approved_by  text REFERENCES custode.app_user(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT material_needs_reason CHECK (NOT material OR reason IS NOT NULL)
);
-- the admin review queue: small, very high signal
CREATE INDEX address_override_material_idx ON custode.address_override (created_at DESC)
  WHERE material;

-- ===========================================================================
-- The ledger
-- ===========================================================================

CREATE TABLE custode.ledger_event (
  seq           bigserial PRIMARY KEY,
  id            text NOT NULL UNIQUE,
  movement_id   text REFERENCES custode.movement(id),
  box_id        text REFERENCES custode.box(id),
  provider_id   text REFERENCES custode.provider(id),
  store_id      text REFERENCES custode.store(id),
  type          text NOT NULL,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id text REFERENCES custode.app_user(id),
  actor_role    text NOT NULL,
  actor_label   text NOT NULL,
  at            timestamptz NOT NULL DEFAULT now(),
  prev_hash     text NOT NULL,
  hash          text NOT NULL
);
CREATE INDEX ledger_movement_idx ON custode.ledger_event (movement_id, seq);
CREATE INDEX ledger_provider_idx ON custode.ledger_event (provider_id, seq);
CREATE INDEX ledger_type_idx     ON custode.ledger_event (type, at DESC);

-- Append-only. Not decorative: a migration that relaxes this is a release blocker.
CREATE FUNCTION custode.ledger_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_is_append_only';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_no_update BEFORE UPDATE OR DELETE ON custode.ledger_event
  FOR EACH ROW EXECUTE FUNCTION custode.ledger_immutable();

CREATE TABLE custode.ledger_root (
  service_date date PRIMARY KEY,
  first_seq    bigint NOT NULL,
  last_seq     bigint NOT NULL,
  merkle_root  text NOT NULL,
  event_count  integer NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  external_ref text
);

-- ===========================================================================
-- Application role: INSERT and SELECT on the ledger, nothing more.
-- ===========================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'custode_app') THEN
    CREATE ROLE custode_app NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA custode, pii TO custode_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA custode, pii TO custode_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA custode, pii TO custode_app;

REVOKE UPDATE, DELETE ON custode.ledger_event FROM custode_app;
REVOKE UPDATE, DELETE ON custode.role_grant_audit FROM custode_app;

COMMIT;
