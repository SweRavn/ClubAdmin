-- SPDX-License-Identifier: AGPL-3.0-only
-- Extracts one club's rows from a restored (scratch) database as CSV files,
-- one per table, until the per-club export (P1.8) exists. Runbook 1.
--
-- Run as superuser inside the scratch PostgreSQL container (the files are
-- written by the server, into a directory owned by postgres):
--   docker exec <container> install -d -o postgres -m 0700 /tmp/club-export
--   docker exec -i <container> psql -U postgres -d clubadmin \
--     -v club=<club id> -v dir=/tmp/club-export < infra/backup/runbooks/export-club.sql
--   docker cp <container>:/tmp/club-export ./club-export
--
-- The files contain personal data: keep them encrypted, only as long as the
-- club's request needs, and delete them afterwards.
\set ON_ERROR_STOP on

-- Every club-owned table (club_id column), the club itself.
SELECT format(
  'COPY (SELECT * FROM %I.%I WHERE %I = %L) TO %L WITH (FORMAT csv, HEADER)',
  c.table_schema, c.table_name,
  CASE WHEN c.table_name = 'clubs' THEN 'id' ELSE 'club_id' END,
  :'club', :'dir' || '/' || c.table_name || '.csv')
FROM information_schema.columns c
JOIN information_schema.tables t
  ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
WHERE c.table_schema = 'public'
  AND ((c.column_name = 'club_id') OR (c.table_name = 'clubs' AND c.column_name = 'id'))
ORDER BY c.table_name
\gexec

-- The club's people (members and others with a profile) and the
-- guardianships of its members; never accounts (login emails).
\set people_file :dir '/people.csv'
\set guardianships_file :dir '/guardianships.csv'
COPY (
  SELECT p.* FROM public.people p
  WHERE p.id IN (SELECT person_id FROM public.club_profiles WHERE club_id = :'club')
) TO :'people_file' WITH (FORMAT csv, HEADER);

COPY (
  SELECT g.* FROM public.guardianships g
  WHERE g.ward_person_id IN (SELECT person_id FROM public.club_profiles WHERE club_id = :'club')
) TO :'guardianships_file' WITH (FORMAT csv, HEADER);
