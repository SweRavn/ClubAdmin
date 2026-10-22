# Backup, restore and disaster recovery

## Targets (hosted service)

| Metric | Target |
|---|---|
| RPO (max data loss), database | ≤ 5 minutes (continuous WAL archiving) |
| RPO, files (object storage) | ≤ 1 hour |
| RTO (time to restore service) | ≤ 4 hours for full loss of the primary site |
| Point-in-time recovery window | 30 days |
| Backup retention | Daily for 35 days, monthly for 12 months (see GDPR note) |
| Restore tests | Automated weekly restore to a scratch environment; manual full DR drill twice a year |

Self-hosters get the same tooling with configurable targets.

## What is backed up

| Data | Method |
|---|---|
| PostgreSQL (app + Zitadel databases) | **pgBackRest**: weekly full, daily differential, continuous WAL archive. Encrypted (AES-256) and compressed before upload. |
| Object storage (documents, images) | Versioned bucket + scheduled replication (rclone) to a second provider |
| Configuration | Infrastructure as code in a private ops repo; secrets in SOPS-encrypted files |
| Encryption keys | Master keys stored in two separate places (secret store + offline sealed copy held by two people) |
| Audit stream | Written to separate append-only storage |

## Protection against breach and ransomware

The key assumption: **an attacker with full control of the production servers
must not be able to destroy or read the backups.**

- Backups go to a **different provider/account** than production (e.g.
  production at provider A, backups at provider B in another EU country).
- Backup bucket uses **object lock (WORM, compliance mode)** for the retention
  period. Production credentials can write new backups but cannot delete or
  overwrite them.
- Backups are encrypted with a key that is not stored on the production
  database host in plain text.
- Separate operator accounts, with hardware-key MFA, for the backup provider.
- Restore runbooks do not depend on production being reachable.

## Restore scenarios

1. **Single club made a mistake** (deleted a team, wrong bulk import): restore
   point-in-time into a scratch database, extract that club's rows with the
   per-club export tool, re-import selected data. Audited, done by operator on
   club request.
2. **Database corruption / bad migration:** point-in-time recovery to just
   before the event (pgBackRest `--type=time`), replay safe changes from the
   audit log if needed.
3. **Total loss of primary site:** provision new infrastructure from IaC in
   another region/provider, restore latest backup, restore object storage
   replica, switch DNS. Target ≤ 4 h.
4. **Breach:** do not restore over evidence. Snapshot compromised systems,
   rebuild clean infrastructure, restore from a backup taken **before** the
   intrusion point (determined from audit and logs), rotate every credential and
   key, force re-login of all users.

Each scenario has a step-by-step runbook in
[`infra/backup/runbooks/`](../../infra/backup/runbooks/README.md), tested in the
DR drill and, where possible, in CI. Every runbook ends with the
deletion-ledger replay and `pnpm ops:verify-backup`.

| # | Runbook |
|---|---|
| 1 | [One club's data from a point in time](../../infra/backup/runbooks/01-single-club.md) |
| 2 | [Point-in-time recovery after a bad migration](../../infra/backup/runbooks/02-point-in-time-recovery.md) |
| 3 | [Total loss of the primary site](../../infra/backup/runbooks/03-total-site-loss.md) |
| 4 | [Breach](../../infra/backup/runbooks/04-breach.md) |

RTO planning: restoring a 10 GB database takes under 30 minutes (target;
measured restores are tracked in
[#14](https://github.com/SweRavn/ClubAdmin/issues/14)).

## Per-club export (data portability)

Every club manager can export the club's full data (JSON + CSV + files, documented
schema). This doubles as the club's own backup and as the migration path away
from the hosted service — the anti-lock-in promise.

## GDPR and backups

- Backups cannot be edited, so deleted personal data lingers until the backup
  expires (max 12 months for monthly backups, documented in the privacy
  notice).
- A **deletion ledger** (IDs of erased persons, not their data) is kept outside
  the backups. After any restore, the ledger is replayed so erased people stay
  erased.
- Implementation (ADR 0030): the ledger is `privacy.deletion_ledger`; the
  backup sidecar exports it (JSON, IDs only) to the backup bucket after every
  backup and every hour. A restore merges the restored ledger, the export and,
  when reachable, production's, and runs `privacy.erase_person` again for
  every entry (`privacy.replay_deletion_ledger`); `privacy.unerased_people()`
  must then be empty. `pnpm ops:restore` and `pnpm ops:verify-backup` do this
  themselves; otherwise `pnpm ops:replay-ledger`.

## Implementation (P0.11)

Details and settings: [`infra/backup/README.md`](../../infra/backup/README.md);
decisions: ADR 0030.

- **Database:** PostgreSQL runs from `clubadmin/postgres` (PostgreSQL 18 with
  pgBackRest), `archive_mode=on`, `archive_timeout` 300 s. The backup sidecar
  (compose profile `backup`) takes weekly full and daily differential backups
  to repo1 (35 days of point-in-time recovery) and monthly full backups to
  repo2 (12 kept), both in the backup bucket, encrypted (AES-256-CBC) and
  compressed (zstd) before upload, with 2 processes so the API is not slowed
  down ([#14](https://github.com/SweRavn/ClubAdmin/issues/14)). Both databases
  of the cluster (`clubadmin`, `zitadel`) are covered.
- **Files:** rclone syncs the files bucket to the replica bucket at a second
  provider hourly (versioning on the target).
- **Bookkeeping:** every run is a row in `ops.backup_runs` (with the key
  tables' row counts at its start), every verification a row in
  `ops.restore_verifications` (checks as JSON) plus an audit event.
- **Credentials:** the backup key is separate from the application's: it reads
  the files bucket and writes the backup and replica buckets; the application
  cannot reach the backups. Secrets come from the environment or files mounted
  at runtime (`*_FILE`), never from files on the database host.

### Verification (`pnpm ops:verify-backup`)

1. Starts a temporary PostgreSQL container (temporary volume, WAL archiving
   off, so it can never write into the repositories).
2. Restores the latest backup and WAL, or `--time <ISO time>`.
3. Checks: migrations (known to this release, unchanged); row counts of the
   key tables within max(50, 5 %) of the last snapshot; row-level security on
   all club tables; history triggers; protected people have no address (the
   constraint is present and holds); `pg_amcheck` on all databases; a sample
   of stored-file keys exists in the file replica (none yet: no table stores
   files before Phase 2); object lock on the backup bucket.
4. Replays the deletion ledger and asserts no erased person has personal data.
5. Records the result in production's `ops.restore_verifications` (when
   reachable) and tears the container and volume down (`--keep` for runbook 1).

Hosted: weekly, scheduled in the private ops repository. Self-hosters: by hand
or from cron (`infra/backup/README.md`). CI runs the whole cycle on every push
(job "backup": full backup, writes, destroyed volume, point-in-time restore,
ledger replay, club export, verification).

### Monitoring

- `GET /api/v1/ops/backup-status` (permission `ops.backup.read`: platform
  operators, the administrators of a self-hosted installation, with a second
  factor): last successful backup per kind (database, monthly, files, ledger
  export), last verification with its checks, and warnings: no database
  backup for 24 hours (`BACKUP_WARN_AFTER_HOURS`), no file replication for 3
  hours, no passed verification for 8 days
  (`RESTORE_VERIFICATION_WARN_AFTER_DAYS`), a failed latest run, or backups
  not enabled. An admin UI follows later.
- The worker exports gauges over OTLP (`clubadmin_backup_last_success_timestamp_seconds{kind}`,
  `clubadmin_backup_last_run_failed{kind}`,
  `clubadmin_restore_verification_last_success_timestamp_seconds`,
  `clubadmin_restore_verification_last_run_failed`); example alert rules:
  [`infra/backup/prometheus-alerts.yml`](../../infra/backup/prometheus-alerts.yml).

### Immutability

Object lock (compliance mode, retention at least the backup retention),
versioning, credentials that cannot delete versions or change the lock, and
a lifecycle rule for non-current versions: see
[`infra/backup/README.md`](../../infra/backup/README.md#immutability-object-lock).
`pnpm ops:object-lock` and every verification check it; Garage (development)
has no object lock and reports "not available".

### Keys

`BACKUP_CIPHER_PASS` and the backup credentials are kept in the secret store
and offline (two people). Rotation of the passphrase means new repositories;
see [`infra/backup/README.md`](../../infra/backup/README.md#keys-and-rotation).

## Self-hosting

`infra/docker/compose.yml` includes the backup sidecar (profile `backup`),
configured by environment variables pointing at any S3-compatible target:
[`infra/backup/README.md`](../../infra/backup/README.md#self-hosting-any-s3-compatible-target).
`pnpm ops:verify-backup` restores the latest backup into a temporary container
and runs the checks above. `GET /api/v1/ops/backup-status` shows the last
successful backup and last verified restore and warns when either is too old
(the admin UI follows later).
