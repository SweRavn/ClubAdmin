# 0025 — Authorization engine: relationship sets, resource scopes and visibility

**Status:** Accepted (P0.7). Refines ADR 0006 and ADR 0022.

**Context.** ADR 0006 decided on an in-process, relationship-based policy
engine and ADR 0022 on one `PersonVisibility` service. Building them (P0.7)
needed decisions the ADRs leave open: how group ownership "inherits through
the hierarchy" when relationships are cached per person, what a guardian
acting for a ward may do, when a denial is 404 rather than 403, how operators
with support access fit in, and how protected sets stay current.

**Decision.**
- **Relationship set.** One statement (`authorization.repository.ts`), run as
  the person, reads their open memberships, roles, group functions, direct
  group ownerships, current employments, unrevoked support grants, operator
  flag, guardianships (both directions) and their wards' memberships. The
  authorization module is the only module that reads other modules' tables,
  read-only. Cached in Valkey per person with a version key; per request it is
  loaded once (`RequestAuthorization`).
- **Group hierarchy at check time, not in the cache.** Ownership of a parent
  group includes its children (ADR 0019). Instead of expanding ownerships into
  the cached set (which would need every club's group tree and invalidation on
  `group.parent.changed`), resource loaders read a group's ancestor chain with
  the group, and `ownsGroup(group)` checks the group and its ancestors. Moving
  a group therefore needs no cache invalidation.
- **Resource scopes.** An endpoint declares `access: { permission, resource }`
  (`club`, `group` or `person`). The loader reads the minimal scope from the
  path (`:clubId`, `:groupId`, `:personId` and `?clubId`): for a group its
  club, ancestors, archived flag and the club's co-owner setting; for a person
  their profile in the club, protected flag and group memberships. The API
  refuses to start when an endpoint's permission has no policy, the resource
  kind differs from the policy's, or the path lacks the parameter.
- **Club insiders.** Anyone with a current relationship with a club (member,
  role, employment, unexpired support access, guardian of a member) may read
  the club and its group structure (new RLS policies `insider_read` on `clubs`
  and `groups`, `app.has_club_relationship`). Group structure is not personal
  data; rosters and profiles have their own policies.
- **Denials.** 404 when the actor has no relationship with the resource's club,
  the resource does not exist, or the resource is a person (a person's
  existence is itself information, and protected persons must be
  indistinguishable from missing ones); 403 otherwise. Cross-club access is
  therefore always 404.
- **Acting on behalf of a ward.** `X-On-Behalf-Of: <personId>` requires an
  active guardianship with the `act_on_behalf` right. Policies then evaluate
  the ward, limited to the ward's club memberships and plain group
  memberships: a guardian never exercises the ward's roles, ownerships,
  leader functions or employments. Services get `{ personId: guardian,
  onBehalfOf: ward }`, so history and audit record both.
- **Operators.** No club access without a grant (`support_access_grants`,
  time-limited, revocable). With one, and a login with a second factor, an
  operator reads the club, its groups and rosters; protected persons stay
  hidden from them.
- **Person visibility.** A club's protected set (club flag, plus the global
  flag of members, guardians of members and join applicants: everyone the club
  can reach) is cached per club with a club version and a global version. A
  protected person is visible to themselves, their guardians and wards
  (family), the club's managers and registrars, and owners (including parent
  groups) and leaders of groups they belong to. The presenter combines the
  set with the rows' own global flag, so a protected guardian who is not a
  member is never shown by mistake. Names leave the API only through
  `PersonPresenter` (lint rule `clubadmin/person-names-in-presenters`).
- **Database backstop.** `app.visible_group_members` leaves out protected
  persons unless the transaction is `viewerPrivileged` (set by the engine for
  managers, registrars, owners and leaders of the group), the person is the
  viewer, or the viewer is their guardian.
- **Invalidation.** Services publish domain events in their transaction; the
  worker's `authorizationCacheHandler` (`@clubadmin/db`) bumps the affected
  version keys in Valkey: the person and their guardians for membership
  changes, both parties for guardianships, the club's protected version for
  membership and club-flag changes, the global protected version for global
  flags and merges. The API reads version and value in one `MGET`; a change
  is visible on the first request after the worker handled the event (LISTEN/
  NOTIFY, well under a second). Without Valkey the API caches nothing across
  requests.
- **RLS cost.** Row-level security is on every query, so its helpers must use
  indexes and be cheap per row: `app.self_and_wards()` (evaluated once per
  statement) lets policies probe the person indexes; the P0.5 `member_read`
  policies on `clubs` and `groups` (a function call per membership row, for
  groups over the whole database) were replaced; `app.can_see_person` and
  `app.has_club_relationship` check one condition per statement, cheapest
  first, because one expression with several subqueries was planned again on
  every call (about 0.2 ms per row). Remaining per-row costs:
  [#9](https://github.com/SweRavn/ClubAdmin/issues/9).
- **Field visibility.** Profiles are filtered per relationship
  (`profileAccess`: self, admin, leader, member). Leaders and administrators
  see a child's guardians with their phone numbers (they must reach them);
  shareable fields of the person (phone, address, gender) reach a club only if
  shared with it, addresses only administrators.

**Consequences.** Checks are in-memory and need no query with a warm cache;
a request pays one Valkey round trip for the relationship set and at most one
for a protected set. Policies are plain functions with allow and deny tests,
and a matrix test runs every permission endpoint for every kind of
relationship. The person summary field is `protected` (was
`protectedIdentity`). A short window remains between a committed change and
the worker's invalidation; endpoints that change relationships (P1.x) may
additionally invalidate synchronously ([#8](https://github.com/SweRavn/ClubAdmin/issues/8)).
