# 0023 — Row-level security for global tables and a person's own relationships

**Status:** Accepted (P0.5)

**Context.** ADR 0004 isolates club-owned tables by `club_id`. The global
tables (`people`, `accounts`, `guardianships`) and cross-club reads ("my clubs
and groups", "my children's groups") had no database-level rule yet. Without
one, any bug in a global query could expose every person in the system, and a
"my clubs" query was impossible because a transaction only sees one club.

**Decision.**
- **Global tables have RLS enabled** (not forced). Policies call `SECURITY
  DEFINER` helpers in schema `app`, owned by the migration role, which read
  `guardianships` without recursing into its own policies:
  - `app.can_see_person(id, created_by)`: the person, their creator, their
    guardians, wards and co-guardians, and in a club transaction the club's
    members (and their guardians and join applicants);
  - `app.is_guardian_of(p)`, `app.is_full_guardian_of(p)` (parent or legal
    guardian), `app.is_self_or_ward(p)`, `app.is_club_manager()`,
    `app.person_has_account(p)`, `app.is_system()` (worker jobs, migrations).
  - `accounts`: only the person's own row; email duplicates are detected by
    the unique index, never by reading other accounts.
  - `guardianships`, `guardian_invitations`, `people_merges`: the family and
    the ward's current club. Accepting a co-guardian invitation goes through
    `app.accept_guardian_invitation(token_hash)`, because the invitee is not
    related yet; the secret token is the proof.
- **Own relationships across clubs:** club-owned relationship tables
  (`club_memberships`, `club_profiles`, `club_role_assignments`,
  `group_memberships`, `consents`, waiting-list entries, join requests,
  hand-overs; `group_owners` and `employments` for the person only) get a
  second, SELECT-only policy `own_relationships`: rows about the acting person
  or their wards are readable in every club. `clubs` and `groups` are readable
  by their members. Writes remain limited to the transaction's club.
- **The CI guard** requires RLS on every table in schema `public`, not only
  on tables with `club_id`.
- Operations that must change one person's rows in several clubs atomically
  (merging duplicates) switch the club inside one transaction with
  `inClub(tx, clubId, fn)` from `packages/db`; RLS still applies per club.

**Consequences.** Authorization (P0.7) stays the primary check and narrows
these rules (for example guardian rights, protected identity); RLS is the
backstop. Policies call functions per row, so queries must filter by indexed
columns (club_id, person_id); the query-plan tests guard the hot paths.
Platform operators get no implicit access; support access arrives with
time-limited grants (P0.7).
