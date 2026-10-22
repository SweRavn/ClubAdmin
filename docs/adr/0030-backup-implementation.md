# 0030 — Backups: one PostgreSQL image, ledger outside the backups, erasure core in SQL

**Status:** Accepted (P0.11). Implements ADR 0014.

**Context.** ADR 0014 chose pgBackRest, encrypted off-site copies with
object lock, weekly restore tests and a deletion ledger re-applied after
restores. Implementing it raised questions ADR 0014 did not answer:

- pgBackRest's `archive_command` runs inside the PostgreSQL container, and
  backups need the data directory;
- the deletion ledger (`privacy.deletion_ledger`) lives in the database, so a
  restore to an earlier point also rolls the ledger back: the people erased
  since then would come back;
- "re-apply the ledger" needs an erasure that can be run again, but
  anonymisation was planned for P1.8;
- the retention in docs/operations/backup-restore.md (35 days of
  point-in-time recovery plus monthly backups for 12 months) does not fit
  one pgBackRest retention policy;
- self-hosters need the same tooling with any S3-compatible target.

**Decision.**

- **One image** (`infra/backup/Dockerfile`): the official PostgreSQL 18
  Alpine image plus pgBackRest and rclone, used by the `postgres` service
  (WAL archiving) and the `backup` sidecar (profile `backup`), which shares
  the data volume and the socket directory. pgBackRest is configured only
  through environment variables mapped by a wrapper (`clubadmin-pgbackrest`),
  with `*_FILE` variants for secrets. The archive command discards WAL unless
  `BACKUP_ENABLED=true`, so installations without backups do not fill
  `pg_wal`. S3 only over HTTPS (pgBackRest): in development through Caddy.
- **Two repositories** in the same bucket: repo1 with weekly full and daily
  differential backups and time-based retention (35 days of point-in-time
  recovery), repo2 with monthly full backups kept 12 times (WAL only for
  their consistency).
- **The deletion ledger is exported outside the backups**: after every
  backup and every hour (with the file replication), as JSON with IDs only,
  to `<path>/deletion-ledger/` in the backup bucket (a dated copy per day;
  object lock and versioning keep history). After any restore the ledger is
  merged from the restored database, the export and, when reachable, the
  production database, and replayed.
- **The erasure core is SQL** (`privacy.erase_person`, migration 0005),
  idempotent and run by `clubadmin_retention`: it anonymises the people row,
  replaces the login email, removes club notes, emergency contacts and
  invitations to the person, scrubs the personal values from the record
  history, and records the ledger entry and an audit event.
  `privacy.replay_deletion_ledger(external)` runs it for every entry;
  `privacy.unerased_people()` must be empty after a restore. The erasure job
  of P1.8 (account deletion, retention) calls this function and extends it
  as modules with personal data arrive.
- **Verification** (`pnpm ops:verify-backup`, package `packages/ops`)
  restores into a temporary container with archiving off, checks migrations,
  row counts against the snapshot taken with each backup
  (`ops.key_table_counts()`), row-level security, history triggers, protected
  identity, `pg_amcheck`, sampled file objects and object lock, replays the
  ledger, records the result in `ops.restore_verifications` with an audit
  event, and always tears the copy down. In-place restores (`pnpm ops:restore`)
  replay the ledger and take a new full backup.
- **Status:** every run writes `ops.backup_runs`; the API serves
  `GET /api/v1/ops/backup-status` (permission `ops.backup.read`, platform
  operators with a second factor, a new `platform` resource kind without IDs)
  and the worker exports gauges for Prometheus alerts.

**Consequences.** `pnpm dev:services` builds the PostgreSQL image (Alpine
packages) and PostgreSQL always runs with `archive_mode=on`. Erasures in the
last hour before a total loss are only in the restored database if its WAL
reached the archive (≤ 5 minutes): the export's hourly delay matters only for
restores to a point before the erasure, where the production ledger is
merged when reachable. The ledger export lists erased person IDs next to the
backups; they are pseudonymous IDs without data. Object lock cannot be
tested in development (Garage has none); the check reports it.
