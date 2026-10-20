# 0017 — Change history for every database record

**Status:** Accepted

**Context.** The maintainer wants to see, for any record, what was changed,
when and by whom. This is for traceability, not for restoring the database
(backups handle that, ADR 0014). The semantic `audit_events` (see
`security.md`, e.g. "Anna moved Elsa to another team") describe intent but not every
column-level change, and they only cover changes made through code paths that
remember to write them.

**Decision.** A generic, trigger-based **record history** in PostgreSQL, in
addition to `audit_events`.

- One table `history.record_changes`, partitioned by month:
  `id`, `table_name`, `record_id`, `club_id` (nullable for global tables),
  `operation` (`INSERT`/`UPDATE`/`DELETE`), `changed_columns`, `old_values` and
  `new_values` (JSONB, **only the changed columns** for updates; full row for
  insert/delete), `actor_person_id`, `on_behalf_of_person_id`, `actor_kind`
  (`person`, `operator`, `system_job`, `migration`, `db_role`), `request_id`,
  `transaction_id`, `db_role`, `changed_at`.
- A single generic trigger function `history.capture()` attached `AFTER
  INSERT OR UPDATE OR DELETE` to every table. It reads the actor from the same
  transaction-local settings the app already sets for RLS
  (`app.person_id`, `app.on_behalf_of`, `app.request_id`, `app.actor_kind`). Changes
  made outside the app (operator SQL, migrations) are still captured, with
  `db_role` and whatever actor the tooling sets; operator tooling and data
  migrations are required to set an actor.
- A migration helper `enableHistory(table, options)` attaches the trigger.
  A CI test fails if any table in the application schemas lacks it, unless it is
  on an explicit exclusion list (job queue, outbox, sessions/cache-like tables,
  the history table itself).
- **Append-heavy tables** (chat messages, attendance marks, notifications) use
  `options.skipInsert`: the row itself carries `created_by`/`created_at`, so only
  updates and deletes are logged. This keeps write amplification and storage
  reasonable.
- **Sensitive columns** (field-level encrypted values) are stored as the
  ciphertext, or with `options.redact` as `"[changed]"` markers only.
- **Access:** RLS on `club_id`. Club managers see history for their club's
  records; anyone who can view a record can see *who* changed it and *which*
  fields; old/new **values** of restricted fields follow the field-level
  permissions of the current record. Operators see global-table history.
- **Tamper resistance:** the app role may only `INSERT` (via the trigger,
  `SECURITY DEFINER`); no `UPDATE`/`DELETE`. Only the retention/erasure job role
  can delete or scrub rows.
- **Retention:** configurable, default 2 years, partitions dropped when expired.
- **GDPR erasure:** when a person is anonymised, the erasure job scrubs their
  personal values from `old_values`/`new_values` (and replaces actor IDs with the
  anonymised person ID, which no longer resolves to a name). The fact that a
  change happened is kept.
- **UI:** a "History" panel on every detail page (member, team, activity,
  document, …) and a filterable history view for club managers.

**Implementation notes (P0.4).**
- The helper is the SQL function `history.enable_history(table, redact, skip_insert)`,
  called from migrations; it creates three *statement-level* triggers with
  transition tables, so bulk changes are captured with one set-based insert per
  statement instead of one per row.
- Redacted columns are stored as `"[changed]"` in inserts, updates and deletes.
- `history.maintain_partitions()` (SECURITY DEFINER) keeps a default partition
  as a safety net and moves rows out of it when it creates a month's partition.

**Consequences.**
- Every write costs one extra insert in the same transaction (small; measured in
  the load scenario against `performance.md` budgets).
- Storage grows; monthly partitions and retention keep it bounded.
- Writes in a transaction without actor settings are recorded with
  `actor_kind = db_role`, so missing context is visible rather than silent.
- Considered and rejected: application-level history (misses changes outside
  the ORM), pgMemento/temporal tables (more complex than needed; we do not need
  point-in-time reconstruction), PostgreSQL logical decoding to an external
  store (extra infrastructure for self-hosters).
