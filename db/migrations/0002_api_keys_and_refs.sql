-- CUSTODE 0002 — API keys, public reference sequences, draft movements.
-- Forward-only.

BEGIN;

-- ===========================================================================
-- API keys (spec §4.1, §6.2)
-- Keys are 32 random bytes (~256 bits of entropy), so a plain SHA-256 lookup
-- hash is appropriate — KDF stretching exists to protect low-entropy secrets.
-- The plaintext is shown once at creation and never stored.
-- ===========================================================================

CREATE TABLE custode.api_key (
  id           text PRIMARY KEY,
  key_hash     text NOT NULL UNIQUE,          -- sha256 hex of the full key
  label        text NOT NULL,
  -- exactly one principal shape: a user key or a provider machine key
  user_id      text REFERENCES custode.app_user(id),
  provider_id  text REFERENCES custode.provider(id),
  live         boolean NOT NULL DEFAULT true, -- false = sandbox
  revoked_at   timestamptz,
  last_used_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT one_principal CHECK (
    (user_id IS NOT NULL) <> (provider_id IS NOT NULL)
  )
);

-- ===========================================================================
-- Public reference sequences (M-####, BX-####)
-- ===========================================================================

CREATE SEQUENCE custode.movement_ref_seq START 4400;
CREATE SEQUENCE custode.box_ref_seq      START 1040;

-- ===========================================================================
-- Draft movements.
-- The packing desk confirms the delivery address BEFORE sealing (§3.3), and the
-- confirmation lives on the movement — so the movement row exists as a DRAFT
-- from the moment a ticket is attached, and becomes BOOKED at booking.
-- ===========================================================================

ALTER TABLE custode.movement DROP CONSTRAINT movement_status_check;
ALTER TABLE custode.movement ADD CONSTRAINT movement_status_check CHECK (status IN
  ('DRAFT','BOOKED','OFFERED','ASSIGNED','PICKED_UP','DELIVERED',
   'EXCEPTION','CANCELLED','RECALLED'));
ALTER TABLE custode.movement ALTER COLUMN status SET DEFAULT 'DRAFT';

-- price and the cancellation clock are set at booking, not at draft
ALTER TABLE custode.movement ALTER COLUMN free_cancel_until DROP NOT NULL;
ALTER TABLE custode.movement ADD CONSTRAINT booked_has_cancel_clock CHECK (
  status = 'DRAFT' OR free_cancel_until IS NOT NULL
);

GRANT SELECT, INSERT, UPDATE, DELETE ON custode.api_key TO custode_app;
GRANT USAGE, SELECT ON custode.movement_ref_seq, custode.box_ref_seq TO custode_app;

COMMIT;
