# Backups

PostgreSQL backups with pgBackRest, replication of the files bucket with
rclone, an export of the deletion ledger, and the restore tooling. The
design and targets are in
[`docs/operations/backup-restore.md`](../../docs/operations/backup-restore.md)
(ADR 0014, ADR 0030); restores are in [`runbooks/`](runbooks/README.md).

## What runs where

| Part | Where | What |
|---|---|---|
| `Dockerfile` | image `clubadmin/postgres:18.6-backup` | PostgreSQL 18 (Alpine) with pgBackRest and rclone. Used by the `postgres` service and the `backup` sidecar. |
| `bin/clubadmin-pgbackrest-archive-push` | PostgreSQL's `archive_command` | Pushes each WAL segment to both repositories (`archive_timeout` 300 s: RPO ≤ 5 minutes). Discards segments unless `BACKUP_ENABLED=true`. |
| `bin/clubadmin-pgbackrest` | both | pgBackRest with its configuration from the `BACKUP_*` variables (no configuration file). |
| `bin/clubadmin-backup` | `backup` sidecar (profile `backup`) | Schedules (busybox cron), backups, file replication, ledger export, restores. `clubadmin-backup help` lists the commands. |
| `packages/ops` | operator's machine or CI | `pnpm ops:verify-backup`, `ops:restore`, `ops:replay-ledger`, `ops:backup`, `ops:object-lock`. |
| `ci-drill.sh` | CI job "backup" | The whole cycle, see below. |
| `prometheus-alerts.yml` | your Prometheus | Example alert rules for the worker's backup metrics. |

Schedules (UTC, configurable):

| Job | Default | Repository |
|---|---|---|
| Full backup | Sunday 02:00 (`BACKUP_SCHEDULE_FULL`) | repo1 |
| Differential backup | Monday–Saturday 02:00 (`BACKUP_SCHEDULE_DIFF`) | repo1 |
| Monthly full backup | 1st of the month 03:30 (`BACKUP_SCHEDULE_MONTHLY`) | repo2 |
| File replication and ledger export | hourly at :17 (`BACKUP_SCHEDULE_FILES`) | files replica, backup bucket |
| WAL | continuously, at least every 5 minutes with activity | repo1 and repo2 |

Retention: repo1 keeps full backups (and the WAL between them) so that every
point of the last `BACKUP_RETENTION_DAYS` (35) days can be restored; repo2
keeps the last `BACKUP_MONTHLY_RETENTION` (12) monthly backups. Every run
is recorded in `ops.backup_runs`, with the row counts of the key tables at
its start (`ops.key_table_counts()`), which a verification compares with.

## Settings

All settings are environment variables (`.env.example`). Secrets can come
from files instead: `BACKUP_CIPHER_PASS_FILE`, `BACKUP_S3_SECRET_ACCESS_KEY_FILE`
and so on, for Docker secrets or a secret manager's agent.

| Variable | Meaning |
|---|---|
| `BACKUP_ENABLED` | `true` to archive WAL and run the sidecar. |
| `BACKUP_S3_ENDPOINT` | `host[:port]` of the S3 API. HTTPS only. |
| `BACKUP_S3_REGION`, `BACKUP_S3_BUCKET`, `BACKUP_PATH` | Where the repositories live (`<path>/repo1`, `<path>/repo2`, `<path>/deletion-ledger/`). |
| `BACKUP_S3_URI_STYLE` | `host` (virtual-hosted, most providers) or `path`. |
| `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` | Backup credentials: not the application's. |
| `BACKUP_S3_VERIFY_TLS`, `BACKUP_S3_CA_FILE` | TLS verification (only development turns it off). |
| `BACKUP_CIPHER_PASS` | Encrypts the repositories (AES-256-CBC, client-side). |
| `BACKUP_RETENTION_DAYS`, `BACKUP_MONTHLY_RETENTION`, `BACKUP_MONTHLY` | Retention; `BACKUP_MONTHLY=false` turns repo2 off. |
| `BACKUP_PROCESS_MAX` | pgBackRest processes (default 2, so backups do not compete with the API). |
| `FILES_SOURCE_S3_*` | The application's files bucket, with read-only credentials. |
| `FILES_REPLICA_S3_*` | The bucket at the second provider (versioning on). |
| `BACKUP_INITIAL_FULL` | Take a full backup when the sidecar starts and none exists (default true). |

The operator tools also read `DATABASE_ADMIN_URL` (superuser of production;
the restored copy has the same roles), `OPS_DOCKER_NETWORK` (network for
the temporary containers, default `clubadmin_backend` when it exists) and
`OPS_BACKUP_IMAGE`.

## Development

```sh
pnpm dev:services --backup   # sets BACKUP_ENABLED=true in .env.local, starts the sidecar
pnpm dev:logs backup
pnpm ops:backup full
pnpm ops:verify-backup
```

In development the repositories are in Garage's `clubadmin-backups` bucket,
reached over HTTPS through Caddy as `s3.clubadmin.localhost` inside the Docker
network, and the file replica is the `clubadmin-files-replica` bucket. The
backup key (separate from the application's) is created by `pnpm dev:services`.

`bash infra/backup/ci-drill.sh` runs the CI drill against the local services
(after `pnpm db:reset --scenario minimal`): full backup, a row written, the
restore point noted, a person erased and another row written, the volume
destroyed, a point-in-time restore, checks that the first row is there, the
second is not, and the erased person was erased again by the ledger replay,
runbook 1's club export, a new full backup and `pnpm ops:verify-backup`.

## Self-hosting: any S3-compatible target

1. Create a bucket at a provider other than the one running ClubAdmin (any
   S3-compatible storage, for example Scaleway, OVH, Hetzner, UpCloud, or
   Garage at another site; ClubAdmin depends on no particular provider,
   ADR 0011). Set the provider's region: there is no default. Turn on versioning, and object
   lock if the provider has it (below).
2. Create credentials that can read and write that bucket only. For the file
   replica: a second bucket (versioning on) and read-only credentials for the
   application's files bucket.
3. Set the variables above in your environment (`.env` next to
   `compose.yml`), with a long random `BACKUP_CIPHER_PASS`. **Keep a copy of
   the passphrase and the S3 credentials outside the server** (password
   manager, sealed envelope): without the passphrase the backups cannot be
   read.
4. `docker compose --profile backup up -d`. The sidecar creates the
   repositories and takes the first full backup; check with
   `docker compose logs backup` and `docker compose exec backup clubadmin-backup info`.
5. Verify a restore regularly, for example weekly from cron on a machine
   with Docker and the same settings:

   ```cron
   # m h dom mon dow
   15 5 * * 1  cd /opt/clubadmin && pnpm ops:verify-backup >> /var/log/clubadmin-verify.log 2>&1
   ```

   `GET /api/v1/ops/backup-status` (platform operators) warns when the last
   backup is older than 24 hours or the last verified restore older than 8
   days.

## Immutability (object lock)

An attacker with control of the production server has the backup
credentials. Object lock keeps what they can reach from destroying the
backups:

- Create the backup bucket **with object lock enabled** (it can only be
  chosen at creation at most providers) and versioning on.
- Default retention: **compliance mode**, at least `BACKUP_RETENTION_DAYS`
  days (35; longer if repo2's monthly backups must be locked for their 12
  months: then a separate bucket for repo2 with 366 days).
- The backup credentials may write but not change the bucket's lock
  configuration or delete object versions (`s3:PutObject`, `s3:GetObject`,
  `s3:ListBucket`, `s3:DeleteObject`; not `s3:DeleteObjectVersion`,
  `s3:PutBucketObjectLockConfiguration`, `s3:BypassGovernanceRetention`).
  pgBackRest's own expiry then only adds delete markers; the locked versions
  stay until their retention ends.
- A lifecycle rule removes non-current versions after the retention, so
  storage does not grow without bound.
- `pnpm ops:object-lock` (and every verification) reads the bucket's
  configuration: `active`, `insufficient` (with the reason), `inactive`, or
  `not-available` when the storage has no object lock (Garage).

## Keys and rotation

- `BACKUP_CIPHER_PASS` is set when a repository is created and cannot be
  changed for it. To rotate: set a new `BACKUP_PATH` (new repositories) and
  the new passphrase, take a full backup, keep the old passphrase until the
  old repositories have passed their retention, then delete them.
- S3 credentials: create the new key, update the settings, restart
  `postgres` and `backup`, run `pnpm ops:backup diff`, then revoke the old key.
- The passphrase and credentials never live on the database host in plain
  text files: they come from the environment or secret files mounted at
  runtime, and an offline copy is kept by two people.
