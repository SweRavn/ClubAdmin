# 0022 — Protected identity

**Status:** Accepted. Implemented in P0.7; details in [ADR 0025](0025-authorization-engine.md).

**Context.** Some members live under protected personal data (in Sweden
*skyddade personuppgifter*) or for other reasons must not be exposed to
other members, in photos or streams. Systems like SportAdmin show a crossed-out
camera next to such members, and they are invisible to other users. Leaks can
put people in danger, so the rule must be impossible to forget in new features.

**Decision.**
- Effective protection = global flag on the person (set by person/guardian)
  OR club-level flag (set by a club manager). Details in `domain-model.md`.
- **One central `PersonVisibility` service** decides, for a viewer and a person
  in a club context, whether the viewer sees the person fully, sees them with the
  protected icon, or does not see them at all. **Every** API response, export,
  notification, calendar feed and history/audit view that refers to people
  goes through it. Repositories return IDs; presenters resolve names via
  this service. A lint rule and tests guard this (no person names serialised
  outside presenters).
- Database-level backstop: list views used by member-facing endpoints exclude
  protected persons unless the viewer is privileged (RLS-style policy on a
  `visible_people` view).
- Chat and shared spaces: protected persons are never auto-added; they join
  only by explicit acceptance, optionally with a display name.
- Streams and photo features refuse to tag protected persons and show leaders
  which participants are protected.
- Every view of a protected person's profile is access-logged.

**Consequences.** Slight overhead on every person-bearing response (the
visibility decision is computed in bulk per request, from the cached
relationship set and a cached set of protected IDs per club). Every feature
prompt must include a protected-identity section, and the prompt template has it.

**Amendment (P1.10b, ADR 0043).** Waiting lists: owners of the group or a
parent group, club managers and registrars may see an applicant on that
group's waiting list (a protected applicant with the icon), as managers see
join-request applicants; nobody else sees applicants, and the waiting count
includes them. Applicants see only their own position and the count.

**Amendment (2026-11-07, P1.12).**
- **Flags in the UI.** The person or a full guardian turns the global flag on
  with one confirmation and off behind a recent login; a guardian may remove
  a child's flag only if they set it (or the one who did is no longer a full
  guardian), so the other parent cannot remove it quietly. Club managers set
  the club flag with a second factor. Every change notifies the affected
  clubs' managers by email and in the inbox, never naming the person.
- **Profile view log.** The access log is a table of its own
  (`profile_views`, one row per club, viewer, viewed person, surface and day
  with a count), not audit events. Views of protected people are always
  logged; **a club may log every profile view**, and then every member sees
  who opened their profile and the profile pages say so. The person and full
  guardians read their log across clubs; club managers read the club's log
  with a second factor. Someone who leaves a club stops being named in its
  log (viewer or viewed), also after a restore (the anonymisation ledger,
  ADR 0030).
- **Chat (rules for Phase 2).** A protected person is never added to a room
  automatically; the room's owner may offer it; the person, or a full
  guardian for a child below `consent_age`, accepts or declines, optionally
  with a display name per club; members then see only that name or the real
  name, as chosen; leaving or withdrawing shows their past messages' author as
  "a member with protected identity"; removing protection adds them to no
  rooms. The tables come with chat.
