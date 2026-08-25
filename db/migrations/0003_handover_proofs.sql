-- CUSTODE 0003 — OTP, signatures, proof photos (spec §1.7), unseal lockout.
-- Forward-only.

BEGIN;

CREATE TABLE custode.otp (
  id           text PRIMARY KEY,
  movement_id  text REFERENCES custode.movement(id),
  box_id       text REFERENCES custode.box(id),
  purpose      text NOT NULL CHECK (purpose IN ('PICKUP','DELIVERY','UNSEAL')),
  code_hash    text NOT NULL,                 -- sha256; the code itself is never stored
  expires_at   timestamptz NOT NULL,
  attempts     integer NOT NULL DEFAULT 0,
  consumed_at  timestamptz,
  approver_user_id text REFERENCES custode.app_user(id),  -- UNSEAL: who received the code
  sent_to      text NOT NULL,                 -- masked destination, for display only
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT otp_subject CHECK (movement_id IS NOT NULL OR box_id IS NOT NULL)
);
CREATE INDEX otp_box_idx ON custode.otp (box_id, created_at DESC) WHERE box_id IS NOT NULL;

CREATE TABLE custode.signature (
  id           text PRIMARY KEY,
  movement_id  text NOT NULL REFERENCES custode.movement(id),
  purpose      text NOT NULL CHECK (purpose IN ('PICKUP','DELIVERY')),
  signer_name  text NOT NULL,
  blob_id      text NOT NULL,
  captured_at  timestamptz NOT NULL DEFAULT now(),
  lat          numeric(9,6) NOT NULL,
  lng          numeric(9,6) NOT NULL,
  accuracy_m   numeric(6,1) NOT NULL
);

CREATE TABLE custode.proof_photo (
  id           text PRIMARY KEY,
  movement_id  text NOT NULL REFERENCES custode.movement(id),
  kind         text NOT NULL CHECK (kind IN
               ('SEAL_AT_PICKUP','SEAL_AT_DOOR','PACKAGE_AT_DOOR','REFUSAL','EXCEPTION','UNKNOWN_ITEM')),
  blob_id      text NOT NULL,
  lat numeric(9,6), lng numeric(9,6),
  captured_at  timestamptz NOT NULL DEFAULT now()
);

-- Five failed unseal codes lock the box for everyone below SUPER_ADMIN (§3.1).
ALTER TABLE custode.box ADD COLUMN unseal_locked boolean NOT NULL DEFAULT false;

GRANT SELECT, INSERT, UPDATE, DELETE ON custode.otp, custode.signature, custode.proof_photo
  TO custode_app;

COMMIT;
