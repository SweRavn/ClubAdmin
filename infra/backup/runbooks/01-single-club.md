# 1. One club's data from a point in time

A club deleted a team, ran a wrong bulk import or similar, and asks for its
data as it was. Production keeps running; nothing is restored over it.

**Who:** an operator, on the club manager's written request (keep it with
the incident). **Time:** about 15 minutes plus the size of the database.

1. Agree on the point in time with the club: just before the mistake. The
   record history and audit log show when it happened:

   ```sql
   -- as superuser on production; the club's ID from the request
   SELECT changed_at, table_name, operation, actor_kind
   FROM history.record_changes WHERE club_id = '<club id>'
   ORDER BY changed_at DESC LIMIT 50;
   ```

2. Restore that point into a scratch container and keep it:

   ```sh
   pnpm ops:verify-backup --time 2026-10-22T08:15:00Z --keep
   ```

   It runs every check (including the deletion-ledger replay, so people
   erased since then stay erased) and prints the container name, for example
   `clubadmin-verify-mgf3k2a1`.

3. Extract the club's rows as CSV files (one per table, plus its people and
   their guardianships; never login emails):

   ```sh
   C=clubadmin-verify-mgf3k2a1
   docker exec $C install -d -o postgres -m 0700 /tmp/club-export
   docker exec -i $C psql -U postgres -d clubadmin -v club=<club id> -v dir=/tmp/club-export \
     < infra/backup/runbooks/export-club.sql
   docker cp $C:/tmp/club-export ./club-export-<club id>
   ```

   Until the per-club export tool exists (P1.8), the club gets these files,
   or the operator re-creates the selected rows through the application.
   Re-importing rows directly into production is not supported.

4. Tear down the scratch copy and handle the files as personal data:

   ```sh
   docker rm -f $C && docker volume rm $C
   ```

   Hand the files over encrypted, delete your copy when the club confirms.

5. Ledger and verification: the scratch restore already replayed the
   deletion ledger (step 2, check `deletion-ledger`); production was not
   restored, so nothing else to replay. Record the request and the
   verification ID in the incident log.
