#!/usr/bin/env bash
# Runs the migration into a scratch database and asserts every guard fires.
set -euo pipefail
DB="${1:-custode_test}"
psql -q -c "DROP DATABASE IF EXISTS $DB;" -c "CREATE DATABASE $DB;"
psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$(dirname "$0")/../migrations/0001_init.sql"
out=$(psql -d "$DB" -f "$(dirname "$0")/guards.sql" 2>&1)
echo "$out" | sed 's/^psql:[^ ]* NOTICE:  //' | grep -E '^\s*(ok|FAIL)' || true
if echo "$out" | grep -q FAIL; then echo "DB GUARDS FAILED"; exit 1; fi
echo "all db guards passed"
