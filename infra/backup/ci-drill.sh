#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Backup drill (CI job "backup"; also runnable locally after
# `pnpm dev:services --backup` and `pnpm db:reset --scenario minimal`):
#
#   full backup → write row A → archive WAL → note time T → erase a person and
#   write row B → export the deletion ledger → archive WAL → destroy the
#   PostgreSQL volume → restore to T (point in time) → A present, B absent,
#   the erased person erased again by the ledger replay → full backup →
#   pnpm ops:verify-backup (latest backup and WAL into a temporary container)
#
# DRILL_COMPOSE overrides the docker compose command (another project).
set -euo pipefail
cd "$(dirname "$0")/../.."

project=${COMPOSE_PROJECT_NAME:-clubadmin}
read -r -a dc <<<"${DRILL_COMPOSE:-docker compose --project-name $project --file infra/docker/compose.yml --file infra/docker/compose.dev.yml --env-file .env.local --profile backup}"
db_user=$(grep -E '^POSTGRES_USER=' .env.local | cut -d= -f2-)

sql() {
  "${dc[@]}" exec -T postgres psql -X -q -At -v ON_ERROR_STOP=1 -U "$db_user" -d clubadmin -c "$1"
}
step() {
  echo "::group::$1"
}
fail() {
  echo "::error::$1"
  exit 1
}

step "Full backup"
pnpm --silent ops:backup full
echo "::endgroup::"

step "Write after the full backup, archive the WAL, note the restore point"
row_a=$(sql "SELECT uuidv7()")
row_b=$(sql "SELECT uuidv7()")
sql "INSERT INTO people (id, given_name, family_name) VALUES ('$row_a', 'Drill', 'Written after the full backup')"
"${dc[@]}" exec -T backup clubadmin-backup check
sleep 2
target=$(sql "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')")
sleep 2
echo "restore point: $target"
echo "::endgroup::"

step "Erase a person and write more after the restore point"
person=$(sql "SELECT id FROM people WHERE anonymized_at IS NULL AND given_name <> '' AND id <> '$row_a' ORDER BY id LIMIT 1")
[ -n "$person" ] || fail "no person to erase in the seeded data"
sql "SELECT privacy.erase_person('$person', 'drill')" >/dev/null
sql "INSERT INTO people (id, given_name, family_name) VALUES ('$row_b', 'Drill', 'Written after the restore point')"
"${dc[@]}" exec -T backup clubadmin-backup ledger-export
"${dc[@]}" exec -T backup clubadmin-backup check
echo "::endgroup::"

step "Destroy the PostgreSQL volume"
"${dc[@]}" stop backup postgres
"${dc[@]}" rm --force backup postgres
docker volume rm "${project}_postgres-data"
echo "::endgroup::"

step "Point-in-time restore to $target"
pnpm --silent ops:restore --time "$target" --yes --no-backup
echo "::endgroup::"

step "Check the restored data"
[ "$(sql "SELECT count(*) FROM people WHERE id = '$row_a'")" = "1" ] || fail "row written after the full backup is missing"
[ "$(sql "SELECT count(*) FROM people WHERE id = '$row_b'")" = "0" ] || fail "row written after the restore point is present"
[ "$(sql "SELECT count(*) FROM privacy.deletion_ledger WHERE person_id = '$person'")" = "1" ] \
  || fail "the erased person is not in the restored deletion ledger"
[ "$(sql "SELECT given_name = '' AND anonymized_at IS NOT NULL FROM people WHERE id = '$person'")" = "t" ] \
  || fail "the erased person has personal data again"
[ "$(sql "SELECT count(*) FROM audit.events WHERE resource_id = '$person' AND action = 'person.erased' AND request_id = 'privacy:ledger-replay'")" = "1" ] \
  || fail "the person was not erased by the ledger replay"
[ "$(sql "SELECT count(*) FROM privacy.unerased_people()")" = "0" ] || fail "erased people with personal data"
echo "A present, B absent, erased person erased again by the ledger replay."
echo "::endgroup::"

step "Runbook 1: extract one club's rows"
club=$(sql "SELECT id FROM clubs ORDER BY id LIMIT 1")
"${dc[@]}" exec -T postgres install -d -o postgres -m 0700 /tmp/club-export
"${dc[@]}" exec -T postgres psql -X -q -U "$db_user" -d clubadmin -v club="$club" -v dir=/tmp/club-export \
  <infra/backup/runbooks/export-club.sql
files=$("${dc[@]}" exec -T postgres sh -c 'ls /tmp/club-export | wc -l')
clubs=$("${dc[@]}" exec -T postgres sh -c 'wc -l < /tmp/club-export/clubs.csv')
[ "$files" -ge 5 ] && [ "$clubs" -eq 2 ] || fail "club export: $files files, clubs.csv has $clubs lines"
"${dc[@]}" exec -T postgres rm -rf /tmp/club-export
echo "exported $files tables of club $club"
echo "::endgroup::"

step "Full backup of the restored database, then verify the latest backup"
pnpm --silent ops:backup full
echo "::endgroup::"
pnpm --silent ops:verify-backup
