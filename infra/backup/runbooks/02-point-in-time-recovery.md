# 2. Point-in-time recovery after a bad migration or corruption

A migration destroyed data, a bug wrote garbage, or the database is
corrupt. The whole cluster (application and Zitadel databases) goes back to
just before the event.

**Time:** minutes for small databases; plan 30 minutes per 10 GB.
**Data loss:** everything written after the chosen point (RPO of the archive
is ≤ 5 minutes, so the point can be very close to the event).

1. Find the point in time:

   ```sql
   -- a migration: when it was applied
   SELECT name, applied_at FROM app_meta.schema_migrations ORDER BY applied_at DESC LIMIT 5;
   -- data damage: the first bad change
   SELECT min(changed_at) FROM history.record_changes WHERE request_id = '<request id>';
   ```

   Choose a time a few seconds before it: `T=2026-10-22T08:14:50Z`.

2. Stop the application (API, worker, web) so nothing writes during the
   restore. Keep PostgreSQL and the backup sidecar running for now.

3. Save the deletion ledger as it is now (production has the newest one;
   the restore rolls the database back):

   ```sh
   pnpm ops:backup files   # replicates files and exports the ledger
   ```

   If the database is too damaged for that, `pnpm ops:restore` still uses the
   last export (at most an hour old) and `--ledger-from` can name a copy.

4. Optionally keep the damaged state for analysis: `pnpm ops:backup full`
   (it becomes an ordinary backup on the old timeline).

5. Restore in place to the point in time:

   ```sh
   pnpm ops:restore --time "$T"
   ```

   It stops the sidecar and PostgreSQL, restores with pgBackRest (`--delta`:
   only changed files), starts PostgreSQL, waits for recovery to reach `T`
   and promote (a new timeline), **replays the deletion ledger**, restarts the
   sidecar and takes a full backup.

6. Fix the cause (revert or correct the migration in a new migration; never
   edit a merged one), deploy, start the application.

7. If safe changes made after `T` must come back, re-apply them from the
   audit log and record history of the damaged copy (step 4) by hand or
   through the application.

8. Verify:

   ```sh
   pnpm ops:verify-backup
   ```
