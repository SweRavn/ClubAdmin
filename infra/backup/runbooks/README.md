# Restore runbooks

Step-by-step procedures for the restore scenarios in
[`docs/operations/backup-restore.md`](../../../docs/operations/backup-restore.md).
Commands are for an installation run with `infra/docker/compose.yml` (the
development checkout or a self-hosted server: run them in the repository
with the installation's settings in the environment or `.env.local`). The
hosted service's own infrastructure steps live in the private ops repository.

| # | Scenario | Runbook | Tested in CI |
|---|---|---|---|
| 1 | One club made a mistake: get its data from a point in time | [01-single-club.md](01-single-club.md) | club export (`export-club.sql`) |
| 2 | Bad migration or corruption: point-in-time recovery of the whole cluster | [02-point-in-time-recovery.md](02-point-in-time-recovery.md) | yes (`ci-drill.sh`) |
| 3 | Total loss of the primary site | [03-total-site-loss.md](03-total-site-loss.md) | restore into an empty volume (`ci-drill.sh`) |
| 4 | Breach | [04-breach.md](04-breach.md) | restore steps as 2; the rest is manual |

Rules for every restore:

- **Never restore over evidence** of a breach (runbook 4 first).
- The restore does not depend on production being reachable: the backups,
  the deletion-ledger export and the settings are enough.
- **Every runbook ends with the deletion-ledger replay and the
  verification.** People erased after the restore point must stay erased
  (docs/gdpr.md); `pnpm ops:restore` replays the ledger itself, any other
  restore needs `pnpm ops:replay-ledger`. Then `pnpm ops:verify-backup`.
- Note in the incident log who restored what, when and why. Restores into
  scratch databases are recorded in `ops.restore_verifications` and the
  audit log (`backup.restore.verified`) and torn down by the tool.

Times are UTC in ISO 8601 (`2026-10-22T08:15:00Z`). Recovery speed: the
target is under 30 minutes for a 10 GB database (RTO planning,
docs/performance.md).
