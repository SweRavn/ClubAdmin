# 0019 — Groups, group owners and waiting lists

**Status:** Accepted

**Context.** Clubs organise themselves in many ways: teams, training groups,
age groups, sections in multi-sport clubs, committees. Popular youth groups
are full and need a fair waiting list that the people running the group can
manage without involving the board.

**Decision.**
- Replace "teams" with a generic **`groups`** entity with a `kind` and an
  optional `parent_group_id` (sections are groups of kind `section`). The UI
  term is configurable per club and kind.
- **Group owners** (`group_owners`): several per group, assigned and removed by
  club managers (optionally by existing owners, per club setting). Owners
  administer the group and its waiting list. Owning a parent group includes
  its child groups.
- **Waiting lists** per group (`group_waitlist_entries`), ordered by priority
  then queue time. Owners admit directly or send time-limited offers; optional
  auto-offer to the next in line when an offer expires or a place frees up.
  Admission can also create the club membership (club setting). Out-of-order
  admission requires an audited reason. Applicants see their own position.
- Event capacity waiting lists (events module) are a separate, simpler
  mechanism and do not reuse this table.

**Consequences.** Permissions are expressed against groups, so the
authorization model has `owner_of(group)` and inherits through the group
hierarchy. Waiting-list positions must be computed efficiently (index on
`(group_id, status, priority desc, queued_at)`).
