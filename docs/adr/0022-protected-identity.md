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
