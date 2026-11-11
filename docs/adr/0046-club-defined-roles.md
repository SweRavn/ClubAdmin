# 0046 — Club-defined roles: permissions in a catalogue, roles per club

**Status:** Accepted, parts A1 and A2 implemented (P1.15; decisions with the
maintainer on 2026-11-08 and 2026-11-11). Parts A3, A4 and B grow this ADR.
Amends ADR 0006 (authorization: policies ask for permissions, not role
names), ADR 0018 (the locked club manager and chair roles), ADR 0019 (group
roles next to ownership) and ADR 0022 (who sees protected people is a
permission).

**Context.** Roles were fixed in code: `CLUB_ROLES` and `GROUP_FUNCTIONS`,
named in about 37 places of the API (policies, but also controllers,
services and the profile tiers), in SQL (row-level security of billing,
imports and guardian invitations; counting `member` rows) and in the
worker's recipient queries. Clubs that are not sports clubs, or sports
clubs organised differently, cannot express who may do what, and every new
role meant code changes in many places.

**Decision.**

- **ClubAdmin defines permissions; clubs combine them into roles.** The
  catalogue (`packages/shared/src/authorization/permission-catalogue.ts`)
  classifies every endpoint permission as `role` (held through roles, with
  a scope `club` or `group`, an area and whether it is sensitive),
  `derived` (decided by another permission plus relationships, e.g.
  `activity.read` follows `group.activities.read`) or `built_in` (own data,
  guardians, operators, club creation; never in a role). Capabilities that
  are not endpoints of their own are role permissions too:
  `group.participate` ("takes part": was `member`), `group.lead` ("counts as
  a leader": was `LEADER_FUNCTIONS`), `group.people.details` and
  `club.people.details` (the profile's leader and admin tiers),
  `club.people.protected` (seeing protected people, ADR 0022),
  `club.members.routine` (membership changes without a second factor each
  time: the registrar's exemption), `club.groups.archived.read` and
  `club.guardianships.end`. Every role permission has a name, a sentence
  and an example in sv, en and nb (`permissionCatalogue` in the message
  catalogues; a test fails without them).
- **Roles are rows per club.** `roles` (scope club or group,
  `template_key`, `locked`, names and descriptions per language or NULL for
  the catalogue text, `version`) and `role_permissions`; both club-owned
  (tenant RLS, history). `club_role_assignments.role_id` and
  `group_memberships.role_id` point at them; the old `role` and `function`
  columns stay (ADR 0029) and triggers fill `role_id` from them for older
  writers. Group memberships carry `participates` and `leads`, kept by
  triggers from the role's permissions, so the hot queries (My schedule,
  rosters, attendance, counts, recipients) read a column instead of joining
  roles.
- **The built-in template** (`BUILT_IN_ROLE_TEMPLATE`, the built-in club
  type) gives today's roles and functions exactly the permissions they had;
  the same table is in SQL (`app.builtin_role_template()`, a test compares
  them). Migration 0030 creates every club's roles from it and backfills
  the assignments club by club; a trigger on `clubs` creates them for every
  new club, whoever inserts it.
- **Policies ask `actor.holds(permission, club | group)`.** A club role's
  permission applies in the club; a group permission held through a club
  role applies in every group of the club; one held through a group role
  applies in that group only. **Group permissions are not inherited by
  child groups** (decision 2026-11-11, as leader functions were); a
  permission may declare `inherits` in the catalogue, none does in A1.
  Ownership keeps its inheritance (ADR 0019). Relational conditions stay in
  the policies (being in the group, guardians, owners, the archived group,
  `onBehalfOf`, MFA). `holdsInAnyGroup(...)` answers "plans some group's
  activities" (creating group events and places).
- **SQL asks `app.holds_permission(club, permission, group)`** (STABLE,
  security invoker) instead of `app.has_club_role(...)`; the RLS policies
  of billing, imports and guardian invitations were recreated with it. The
  worker asks `clubHolders(club, permission)` and the activity groups'
  holders (`apps/worker/src/holders.ts`).
- **Locked roles may be named.** The club manager (`club.roles.manage`,
  and from A2 `club.people.protected`) and the chair (`club.managers.claim`)
  are locked: they cannot be deleted and keep their locked permissions, so
  the handover, recovery and last-manager code (ADR 0018) may still name
  them. Everything else is checked by the lint rule
  `clubadmin/no-role-names` (API and worker; the roles module, the seed and
  tests excepted).
- **Caching.** The relationship set (ADR 0006) carries each assignment's
  role ID and permissions, read in the same statement (the
  `role_permissions` rows of the person's own roles, through the
  `own_roles` policy and the person indexes). Its Valkey key carries the
  set's shape (`authz:rel:2:`), so sets cached by an older release are
  never read. Roles cannot be edited in A1; A2 adds the per-club version
  that invalidates sets when a role's permissions change.

**Club managers and protected identity (decision 2026-11-11).** The person
who assigns roles must be able to find every member, protected people
included, and see that they are protected, or protected members could not
be given roles or would be handled blindly. From A2 the club manager role
always holds `club.people.protected` (locked): club managers see who is
protected (name and marker in the club's lists), not their details, unless
another role gives `club.people.details`. In A1 the template gives it to
club managers and registrars, as before.

**Consequences.**

- Behaviour is unchanged in A1: the policy tests (411 cases) build their
  actors from the template and pass unchanged, and the permission matrix
  of the integration tests is the same for every persona.
- A role's permissions are read once per relationship set; the request
  budgets did not grow.
- Code that decides by a role name fails lint; display code that names a
  role (a label such as "ask the treasurer", the access log's role label)
  says why in its disable comment.
- Web and mobile still read the old `roles` and `functions` fields for
  hints (e.g. who may merge duplicates); A2 moves them to
  `/me/permissions`.

## Part A2: editable roles, the club manager's split, immediate effect

**Decision.**

- **The club manager administers, the registrar does the register's
  work** (decision 2026-11-08). Migration 0032 gives the club manager the
  club's administration: settings, roles (`club.roles.manage`,
  `club.roles.read`), groups and owners, invitations, join requests and
  waiting lists, places and events, protection flags and duplicates, the
  audit log and the history of groups, activities and events, the
  subscription and billing. The register's details, membership changes,
  adding and importing members, guardians, consents, own logins, member
  history and correcting locked attendance moved to the registrar
  (`MANAGER_SPLIT`); the managers of existing clubs are told (notice and
  email), and the roles page offers them the registrar role in one click.
  The club manager still plans every group's activities and so takes
  attendance as a planner. Board members and club managers read the
  register's names and open a member's profile with the name only (tier
  "member"); club managers see protected people (decision 12).
- **Locked permissions**: the club manager keeps `club.roles.manage` and
  `club.people.protected`, the chair `club.managers.claim`; locked roles
  cannot be deleted.
- **Roles are created, changed (from the version the editor saw: 409
  `role_changed`), copied, reset to the template and deleted** (archived:
  history keeps them; holders move to a replacement of the same scope, or
  their assignments end). A group role holds group permissions only.
- **Assignment**: club roles through `/clubs/:clubId/role-assignments`
  (club.roles.manage), group roles in the group's member list (the body's
  `roleId`). Without club.roles.manage a role may only be given if the
  caller holds its permissions in the group (owners: what owning gives;
  taking part and counting as a leader are not powers);
  `/groups/:groupId/assignable-roles` lists those roles.
- **The old columns stay**: `role_id` is NOT NULL; a club's own roles fill
  `role`/`function` with a stand-in (`staff`; `member` for a role that
  takes part, else `other_leader`) so older readers keep working (ADR
  0029); uniqueness moved to the role.
- **Immediate effect** (deviation from the prompt's per-club version): a
  change of a role's permissions publishes `role.updated`; the worker bumps
  the relationship version of every holder and of their guardians, as it
  does for every other relationship change (well under a second). Every
  authenticated response carries `x-authz-version` (the caller's version);
  the mobile app refetches what it shows when it changes, the web app reads
  permissions on every page anyway, and a refused form says the
  permissions may have changed. The silent push is not built (best effort
  in the prompt; the header is what guarantees it).
- **People are told**: holders of a role that lost permissions, a person
  whose role was ended, and, when an administrator gives themselves a
  role, the other administrators and the chair (mandatory email).

**Consequences.** The permission matrix differs from A1 only by the table
of intended changes in `authorization.integration.test.ts` (the club
manager's register, guardian, consent and member-history endpoints). The
role's own history panel (ADR 0042) is not built yet: role changes are in
the club's history and the audit log (`role.*`).
