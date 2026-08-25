-- Database-level invariant tests (spec §11.2).
-- These assert that the guards fire, not that the columns exist. Run with:
--   psql -d custode_test -v ON_ERROR_STOP=1 -f db/test/guards.sql

\set QUIET on
\pset tuples_only on
\pset format unaligned

CREATE OR REPLACE FUNCTION pg_temp.expect_fail(sql text, want text, label text)
RETURNS void AS $$
BEGIN
  BEGIN
    EXECUTE sql;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%' || want || '%' THEN
      RAISE NOTICE '  ok   %', label;
      RETURN;
    END IF;
    RAISE NOTICE '  FAIL % -> wrong error: %', label, SQLERRM;
    RETURN;
  END;
  RAISE NOTICE '  FAIL % -> statement was ALLOWED', label;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION pg_temp.expect_ok(sql text, label text)
RETURNS void AS $$
BEGIN
  EXECUTE sql;
  RAISE NOTICE '  ok   %', label;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '  FAIL % -> %', label, SQLERRM;
END $$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- fixtures
SET custode.actor_role = 'SUPER_ADMIN';

INSERT INTO custode.provider (id, name, legal_name) VALUES ('prv_1','BMobile','BMobile inc.');
INSERT INTO custode.store (id, provider_id, name, address_line1, address_city, address_postal)
  VALUES ('str_1','prv_1','BMobile Beaubien','6321 rue Beaubien E','Montréal','H1M 2Y8');
INSERT INTO custode.app_user (id, role, provider_id, store_id, display_name, phone_e164)
  VALUES ('usr_rep','STORE_REP','prv_1','str_1','Amélie Fortin','+15145550231'),
         ('usr_mgr','STORE_MANAGER','prv_1','str_1','Karim Haddad','+15145550288');
INSERT INTO custode.seal_range (id, prefix, first_no, last_no, store_id)
  VALUES ('rng_1','CS-',40100,40199,'str_1');
INSERT INTO custode.seal (id, seal_no, range_id, issued_to_store)
  VALUES ('seal_1','CS-40118','rng_1','str_1'), ('seal_2','CS-40119','rng_1','str_1');
INSERT INTO custode.box (id, box_ref, store_id, packed_by)
  VALUES ('box_1','BX-1042','str_1','usr_rep');
INSERT INTO pii.recipient (id, full_name, phone_e164) VALUES ('rcp_1','Geneviève Bilodeau','+15145550142');
INSERT INTO pii.address (id, line1, city, postal, hash_salt)
  VALUES ('adr_fetched','6321 rue Beaubien E','Montréal','H1M 2Y8','salt-abc'),
         ('adr_shipped','6321 rue Beaubien E','Montréal','H1M 2Y8','salt-abc');

\echo ''
\echo 'role grants'
SELECT pg_temp.expect_fail($$
  SET custode.actor_role = 'PROVIDER_ADMIN';
  UPDATE custode.app_user SET role='STORE_MANAGER' WHERE id='usr_rep';
$$, 'store_manager_requires_super_admin', 'a provider cannot promote its own rep to manager');

SET custode.actor_role = 'SUPER_ADMIN';
SELECT pg_temp.expect_ok($$
  INSERT INTO custode.app_user (id, role, provider_id, store_id, display_name)
  VALUES ('usr_mgr2','STORE_MANAGER','prv_1','str_1','Second Manager');
$$, 'SUPER_ADMIN can create a manager');

\echo ''
\echo 'user scoping'
SELECT pg_temp.expect_fail($$
  INSERT INTO custode.app_user (id, role, display_name) VALUES ('usr_bad','STORE_REP','No Scope');
$$, 'scope_shape', 'a store role must be scoped to a store');

SELECT pg_temp.expect_fail($$
  INSERT INTO custode.app_user (id, role, provider_id, display_name)
  VALUES ('usr_bad2','DRIVER','prv_1','Scoped Driver');
$$, 'scope_shape', 'a CUSTODE role must not be scoped to a provider');

\echo ''
\echo 'manifest'
SELECT pg_temp.expect_ok($$
  INSERT INTO custode.manifest_line (id, box_id, code, item_type, label, qty, value_cents, scanned_by)
  VALUES ('ml_1','box_1','356938035643809','IMEI','iPhone 16 Pro',1,144900,'usr_rep');
$$, 'scan into an OPEN box');

SELECT pg_temp.expect_fail($$
  INSERT INTO custode.manifest_line (id, box_id, code, item_type, label, qty, value_cents, scanned_by)
  VALUES ('ml_bad','box_1','490154203237518','IMEI','Galaxy',2,129900,'usr_rep');
$$, 'serialized_qty', 'a serialized item cannot have qty > 1');

SELECT pg_temp.expect_fail($$
  INSERT INTO custode.manifest_line (id, box_id, code, item_type, label, scanned_by)
  VALUES ('ml_bad2','box_1','0009988776655','UNKNOWN','Unidentified','usr_rep');
$$, 'unknown_needs_photo', 'an unknown item must carry a photo');

SELECT pg_temp.expect_ok($$
  INSERT INTO custode.manifest_line (id, box_id, code, item_type, label, qty, value_cents, scanned_by)
  VALUES ('ml_2','box_1','194253407409','SKU','Chargeur MagSafe',1,5900,'usr_rep');
$$, 'a SKU scans normally');

-- seal it
UPDATE custode.box SET status='SEALED', current_seal_id='seal_1', seal_count=1,
       sealed_at=now(), declared_cents=150800 WHERE id='box_1';
UPDATE custode.seal SET status='APPLIED', applied_at=now() WHERE id='seal_1';

SELECT pg_temp.expect_fail($$
  INSERT INTO custode.manifest_line (id, box_id, code, item_type, label, qty, value_cents, scanned_by)
  VALUES ('ml_3','box_1','190199267123','SKU','Câble',1,2500,'usr_rep');
$$, 'manifest_locked', 'no scan after the box is sealed');

SELECT pg_temp.expect_fail($$
  DELETE FROM custode.manifest_line WHERE id='ml_1';
$$, 'manifest_locked', 'no deletion after the box is sealed');

SELECT pg_temp.expect_fail($$
  UPDATE custode.manifest_line SET qty=9 WHERE id='ml_2';
$$, 'manifest_locked', 'no edit after the box is sealed');

\echo ''
\echo 'seals'
UPDATE custode.seal SET status='VOIDED', voided_at=now(), void_reason='Wrong item packed' WHERE id='seal_1';
SELECT pg_temp.expect_fail($$
  UPDATE custode.seal SET status='APPLIED' WHERE id='seal_1';
$$, 'seal_voided_is_terminal', 'a voided seal can never be reapplied');

SELECT pg_temp.expect_fail($$
  INSERT INTO custode.seal (id, seal_no, range_id) VALUES ('seal_dup','CS-40118','rng_1');
$$, 'duplicate key', 'a seal number is globally unique');

\echo ''
\echo 'movement and address'
INSERT INTO custode.movement
  (id, movement_ref, provider_id, store_id, box_id, service_code, price_cents, declared_cents,
   recipient_id, address_id, address_fetched_id, address_hash, free_cancel_until)
VALUES
  ('mov_1','M-4473','prv_1','str_1','box_1','CUSTODE_24',1075,150800,
   'rcp_1','adr_shipped','adr_fetched','9f2c'||repeat('0',60), now() + interval '60 min');

SELECT pg_temp.expect_fail($$
  UPDATE custode.movement SET address_fetched_id='adr_shipped' WHERE id='mov_1';
$$, 'address_fetched_is_immutable', 'the fetched address can never be rewritten');

SELECT pg_temp.expect_ok($$
  UPDATE custode.movement SET address_id='adr_fetched', address_overridden=true WHERE id='mov_1';
$$, 'the shipped address may change');

SELECT pg_temp.expect_fail($$
  INSERT INTO custode.address_override (id, movement_id, fields, material, changed_by)
  VALUES ('ovr_bad','mov_1', ARRAY['line1'], true, 'usr_rep');
$$, 'material_needs_reason', 'a material override cannot be recorded without a reason');

SELECT pg_temp.expect_ok($$
  INSERT INTO custode.address_override (id, movement_id, fields, material, reason, changed_by)
  VALUES ('ovr_1','mov_1', ARRAY['line1'], true, 'Customer called to change delivery address','usr_rep');
$$, 'a material override with a reason is accepted');

SELECT pg_temp.expect_ok($$
  INSERT INTO custode.address_override (id, movement_id, fields, material, changed_by)
  VALUES ('ovr_2','mov_1', ARRAY['note'], false, 'usr_rep');
$$, 'a minor correction needs no reason');

\echo ''
\echo 'ledger'
INSERT INTO custode.ledger_event (id, movement_id, box_id, provider_id, store_id, type, detail,
                                  actor_user_id, actor_role, actor_label, prev_hash, hash)
VALUES ('evt_1','mov_1','box_1','prv_1','str_1','box.sealed','{"seal_no":"CS-40118"}',
        'usr_rep','STORE_REP','Amélie Fortin', repeat('0',64), 'aa'||repeat('1',62));

SELECT pg_temp.expect_fail($$
  UPDATE custode.ledger_event SET detail='{"seal_no":"CS-99999"}' WHERE id='evt_1';
$$, 'ledger_is_append_only', 'a ledger event can never be updated');

SELECT pg_temp.expect_fail($$
  DELETE FROM custode.ledger_event WHERE id='evt_1';
$$, 'ledger_is_append_only', 'a ledger event can never be deleted');

SELECT pg_temp.expect_ok($$
  INSERT INTO custode.ledger_event (id, type, actor_role, actor_label, prev_hash, hash)
  VALUES ('evt_2','admin.rate_changed','SUPER_ADMIN','Owner', 'aa'||repeat('1',62), 'bb'||repeat('2',62));
$$, 'appending is allowed');

\echo ''
\echo 'grants'
SELECT '  ' || CASE WHEN has_table_privilege('custode_app','custode.ledger_event','UPDATE')
                    THEN 'FAIL app role HAS update on the ledger'
                    ELSE 'ok   app role cannot UPDATE the ledger' END;
SELECT '  ' || CASE WHEN has_table_privilege('custode_app','custode.ledger_event','DELETE')
                    THEN 'FAIL app role HAS delete on the ledger'
                    ELSE 'ok   app role cannot DELETE the ledger' END;
SELECT '  ' || CASE WHEN has_table_privilege('custode_app','custode.ledger_event','INSERT')
                    THEN 'ok   app role can INSERT into the ledger'
                    ELSE 'FAIL app role cannot append' END;
\echo ''
