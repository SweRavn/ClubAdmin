# 0041 — Privacy: consents per purpose, leaving without open assignments, board-decided settings, retention as its own role

**Status:** Accepted (P1.8a; P1.8b extends it with exports and erasure).

**Context.** Until P1.8 consents were a schema without endpoints, a member
could not leave a club themselves, the retention periods of `gdpr.md` for
former members and the audit log were not enforced, and the settings a
club's board decides (how long it keeps data, which consents it asks for)
were plain settings any club manager could change. The decisions below
were taken with the maintainer on 2026-11-01.

**Decision.**

- **Consents per purpose.** Each purpose is given and withdrawn on its own,
  for the whole club: photo publication, video publication, streaming,
  marketing, sharing with federations, and two contact purposes: the phone
  a person shared with the club is visible to the other members of their
  groups and their guardians (`contacts_group`) or to everyone in the club
  (`contacts_club`). A guardian decides the contact purposes for their own
  phone only (shown on a ward's card), never for another adult's. Without
  the consent the field visibility of P0.7 applies unchanged. The person
  decides from the country pack's consent age; a full guardian gives for a
  younger ward and may withdraw until the adult age; a consent given before
  the consent age stays until someone withdraws it. Registrars and club
  managers record a paper consent with a note and withdraw on request.
  Protected persons cannot have photo, video, streaming or contact
  consents; setting the flag ends them (`privacy:protection_changed`).
- **Versioned texts.** A consent records the text version agreed to: the
  platform's default (`default:<n>`, messages in packages/i18n, locked by
  a hash test) or the club's own (`club:<n>`, immutable rows). A new club
  version revokes older consents only if the club decided so.
- **No leaving with open assignments or debts.** Leaving a club is refused
  while the person holds a club role, a leader function or a group
  ownership (they step down first, one by one, or the club ends them; the
  last club manager hands over first), or while invoices from the club are
  neither paid nor written off. No module issues invoices to members yet:
  modules register an `OutstandingObligations` provider (finance, Phase 3).
  Memberships ended by the club still end assignments with them. Leaving
  ends the membership, groups, pending join requests, waiting-list places,
  registrations to coming events and consents in one transaction; adults
  leave themselves, a minor's full guardians leave for them.
- **Board-decided settings.** The settings registry of ADR 0037 starts in
  `packages/shared` (`club-settings.ts`, `retention.ts`): each setting has
  a stable key, limits (narrowed by the country pack, never widened) and
  `decidedBy`. Board settings change only through a recorded decision
  (`club_setting_decisions`: body, date, minutes reference, effective
  date); ClubAdmin records the decision and does not judge it. Applying a
  decision (`app.apply_setting_decision`, at once or by
  `clubs:apply_decisions`) publishes the next version of the club's privacy
  policy (`club_privacy_policies`, a snapshot of the values), and members
  are told. The policy is rendered when read from a versioned template and
  shows which decision each value rests on.
- **Retention as its own database role.** The worker's privacy jobs run as
  `clubadmin_retention` (`DATABASE_RETENTION_URL`): former members are
  purged after the club's period (`privacy.purge_former_member`, minimised
  facts stay), people without a login and without any relationship are
  marked and erased after `ORPHAN_RETENTION_MONTHS` (never accounts with a
  login), and the audit log is deleted after `AUDIT_RETENTION_MONTHS`.
  `privacy.erase_person` now also clears join request, waiting-list and
  guardianship notes, invitations to the person's address and open
  consents.
- **Immutable backups.** Erasure never touches backups: erased people stay
  in the backups taken before, encrypted, until they expire; any restore
  replays the deletion ledger before the database is used.

**Consequences.**

- Members see and change their consents on `/me/privacy` and in the app;
  leaders see their group's consents; the club's privacy page shows the
  policy, the rules and the decisions.
- Notices `membership.left`, `assignment.ended` and
  `club.privacy_policy.updated` join the catalogue (ADR 0039).
- The group roster does not show phones (its budget is three statements);
  the profile does.
- Deferred: restorable club profiles (a sealed archive of a purged
  profile); a second board member confirming a decision; decisions taken
  from adopted minutes (Phase 2, ADR 0037).
