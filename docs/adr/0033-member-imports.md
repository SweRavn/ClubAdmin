# 0033 — Member imports: jobs in the API process, CSV only, staging rows

**Status:** Accepted (P1.3b).

**Context.** A club moving to ClubAdmin imports its members from a
spreadsheet (P1.3b): thousands of rows with children, guardians, groups and
membership dates. Every row must be written through the domain services
(people, memberships, groups, guardianships, accounts) so audit events,
history, invariants and invitations work as for members added by hand. Those
services live in `apps/api`; the worker app (`apps/worker`) may not import
them (dependency-cruiser: apps never import other apps). Parsing 10,000 rows
takes seconds and importing them minutes: too long for a request. The prompt
also asks for XLSX if a parser is on the licence allow list and never
evaluates formulas.

**Decision.**

- **The import jobs run in the API process.** `members:import_parse` and
  `members:import_run` are Graphile Worker tasks run by a runner the API
  starts next to Fastify (`MEMBER_IMPORT_JOBS`, default on;
  `MEMBER_IMPORT_CONCURRENCY`, default 1). Both runners share the
  `graphile_worker` schema; a runner fetches only the tasks it knows, so the
  worker app never picks up import jobs and the API never picks up the
  worker's. Jobs are queued by a SECURITY DEFINER trigger when an import's
  status changes to `parsing` or `importing` (the same pattern as exports in
  migration 0008), in the transaction that changes it. Payloads are IDs only.
  A deployment that wants the jobs elsewhere runs a second API instance with
  `MEMBER_IMPORT_JOBS=true` and the others with `false`.
- **Each job acts as a person.** Parsing runs as the registrar who started
  the import, the run as the one who confirmed it (tenant context, so row
  level security, audit actors and the services' permission checks apply).
  If the confirmer has lost the club role, the import fails with
  `not_allowed`.
- **CSV only.** UTF-8 (with or without BOM) or Windows-1252, `,`/`;`/tab
  detected from the header line, a small RFC 4180 parser in the API. No XLSX
  parser on the allow list is both maintained and free of formula
  evaluation or macro handling we would have to audit; the UI asks for CSV
  ("Save as CSV" in the spreadsheet program). `xlsx` stays in the format enum
  (ADR 0029) and answers `import_format_unsupported`.
- **Staging rows.** The file is read once and deleted; its rows are kept
  sealed (field encryption with the club's key, the whole row of cells) in
  `member_import_rows` so the mapping can change without the file. The
  mapped values are kept in `data` for the preview, with the personal
  identity number sealed separately and a blind index for duplicate checks.
  Staging rows have no record history (listed in `history-exclusions.ts`)
  and are deleted with the file seven days after the import ends; the
  `member_imports` row stays with its counts (the headers redacted in its
  history).
- **Duplicates only within the club.** Rows are compared with the people who
  have a profile in the club (identity number hash, or birth date with the
  family or given name). An exact match is `already_in_club` (skipped, which
  makes a re-run with the same file skip every row); a near match is
  `possible_duplicate`, which the registrar resolves as the same or a
  different person. People outside the club are never compared.
- **Guardians.** Any number per row (`guardian.<n>.<field>` columns) or one
  row per guardian with a family key. A guardian with an email and
  invitations on gets a guardian invitation from the club (the guardianship
  starts when they accept, with whichever login they have); the others are
  recorded as people without login, one person per name and phone across the
  file. A minor's email is moved to a guardian without one, never stored.
- **Batches.** The run job imports 100 rows per transaction, each row under
  a savepoint: a failed row is marked `import_failed`, a failed batch is
  marked and the rest continues, and a retried job continues after the
  imported rows (guardians it created are remembered from the rows).

**Consequences.** The API process needs the database role's access to the
`graphile_worker` schema, which it already has (it enqueues jobs through
triggers). Import throughput scales with API instances that run jobs, not
with workers. Adding XLSX later is a parser and an ADR update; the rest of
the pipeline reads rows of strings.
