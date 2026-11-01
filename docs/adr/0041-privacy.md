# 0041 — Privacy: consents per purpose, leaving without open assignments, board-decided settings, retention as its own role

**Status:** Accepted (P1.8a; extended in P1.8b with "download my data",
account deletion and ward erasure).

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

**P1.8b: download, deletion, erasure.**

- **"Download my data"** is one request per subject (the person, or a ward
  of a full guardian), at most three a day, written by `privacy:export` as
  a ZIP (`data.json` with a versioned schema, `docs/api/data-export.md`,
  and a self-contained `index.html` in the requester's language) streamed
  part by part into a multipart upload. Other people are named through the
  PersonPresenter as the requester may see them. Only the requester
  downloads it, with a recent login, through a five-minute link; the file
  goes after seven days (`privacy:expire_exports`), the row after 12
  months. The files live under `data-exports/` with their own lifecycle
  rule (eight days): the `exports/` rule of member exports (two days)
  would delete them before the seven days are over.
- **Account deletion** waits `ERASURE_GRACE_DAYS` (default 14, 0–30) and
  can be cancelled until then; a banner says so on the web and in the app.
  The blockers of leaving a club apply in every club, to the person and to
  each ward erased with them; the preview names each with the club, and
  the job checks again (a role given during the grace period stops it,
  `error_code = blocked`, and the person is told with the notice
  `account.deletion.blocked`). Wards without a login whose only full
  guardian with a login is the person are erased too unless the person
  keeps them. A full guardian erases a ward without a login the same way;
  every other full guardian is told and may cancel.
- **The jobs run in the API's job runner** (ADR 0033), not the worker:
  `privacy:export` needs the presenter and the field encryption,
  `privacy:erase` leaves clubs and ends guardianships through the domain
  services and revokes sessions in Valkey and Zitadel. The API gets the
  retention handle (`DATABASE_RETENTION_URL`) for `privacy.erase_person`
  and for checking the blockers across clubs; without it erasures wait
  (`erasure_unavailable`). The Zitadel user is deleted after the database
  part by the `clubadmin-api` machine user (instance role
  `IAM_USER_MANAGER`, `pnpm auth:configure`); its ID waits in the request
  until then, so a failure there is retried and the database erasure is
  never rolled back.
- **Cross-club facts for the caller** come from two `SECURITY DEFINER`
  functions limited to the caller and their wards
  (`app.erasure_assignments`, `app.ward_logins`): with row-level security
  a person sees only their own relationships, not whether they are a
  club's last manager or whether a co-guardian has a login. Names and
  logins are looked up by key so their cost does not grow with the data.

**Consequences.**

- Members see and change their consents on `/me/privacy` and in the app;
  leaders see their group's consents; the club's privacy page shows the
  policy, the rules and the decisions.
- Notices `membership.left`, `assignment.ended` and
  `club.privacy_policy.updated` join the catalogue (ADR 0039).
- The group roster does not show phones (its budget is three statements);
  the profile does.
- P1.8b: `/me/privacy` gains "Download my data" and "Delete my account"
  (`/me/privacy/delete`); a ward's family entry gains "Delete {name}'s
  data" (`/me/family/{id}/erase`); the app has account deletion under
  Settings → Privacy. Notices `privacy.export.ready`,
  `account.deletion.scheduled`, `account.deletion.blocked` and
  `person.erasure.scheduled` (mandatory emails) join the catalogue.
- Deferred: restorable club profiles (a sealed archive of a purged
  profile); a second board member confirming a decision; decisions taken
  from adopted minutes (Phase 2, ADR 0037).
