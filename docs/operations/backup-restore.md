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

Each scenario has a step-by-step runbook in `infra/backup/runbooks/` (Phase 0
task), tested in the DR drill.

## Per-club export (data portability)

Every club admin can export the club's full data (JSON + CSV + files, documented
schema). This doubles as the club's own backup and as the migration path away
from the hosted service — the anti-lock-in promise.

## GDPR and backups

- Backups cannot be edited, so deleted personal data lingers until the backup
  expires (max 12 months for monthly backups, documented in the privacy
  notice).
- A **deletion ledger** (IDs of erased persons, not their data) is kept outside
  the backups. After any restore, the ledger is replayed so erased people stay
  erased.

## Self-hosting

`infra/docker/compose.yml` includes a backup sidecar (pgBackRest) configured by
environment variables pointing at any S3-compatible target. `pnpm ops:verify-backup`
restores the latest backup into a temporary container and runs integrity checks.
The admin UI shows the last successful backup and last verified restore, and
warns when either is too old.
