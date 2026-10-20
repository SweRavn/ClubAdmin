# 0009 — Background jobs in Postgres (Graphile Worker)

**Status:** Accepted

**Context.** Emails, push, reminders, exports, retention jobs and scheduled
tasks must be reliable and transactional with the data that triggers them.

**Decision.** Graphile Worker (MIT): jobs stored in Postgres, picked up via
LISTEN/NOTIFY, cron-like scheduling. Jobs are enqueued in the same transaction
as the business change (or from the outbox).

**Consequences.** No separate queue service, jobs are included in database
backups. If job volume one day overwhelms Postgres, the job interface allows
moving to a dedicated queue.
