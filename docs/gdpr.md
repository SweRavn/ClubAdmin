# GDPR and privacy

## Roles

- **The club is the data controller** for its members' data.
- **The hosted-service operator is the data processor** (personuppgiftsbiträde).
  Every club accepts a data processing agreement (DPA) when it signs up; the list
  of sub-processors is public and clubs are notified of changes.
- **Self-hosting organisations** are controller (and their own processor).
- **Push notifications** (P1.7) go through Expo's push service (a
  sub-processor when the server sets `PUSH_PROVIDER=expo`): it receives
  the device's push token, a title and body without people's names
  (or only "New notification" with lock-screen text off), the notice's ID
  and a path with IDs. Without `PUSH_PROVIDER` nothing leaves the server.
- The person's global account data (login, preferences) is controlled by the
  operator; this is described in the platform privacy notice.

## Principles in the product

| Principle | How |
|---|---|
| Data minimisation | Only `given_name`, `family_name`, `birth_date` and one contact method required. Personal identity number only when the country pack needs it (e.g. LOK-stöd) and only visible with elevated rights. |
| Purpose limitation | Consents are per purpose (photo publication, streaming, sharing with federation, marketing). |
| Storage limitation | Retention rules per data category, configurable per club within legal limits, enforced by a nightly job. |
| Integrity & confidentiality | See `security.md`. |
| Accountability | Audit log, record of processing activities (ROPA) template generated per club. |
| Billing of the service (P1.13, billing on only) | Billing data is about the club as a customer: no member data, no person IDs in `billing`. The invoice email and "reference" may identify a person: the form asks for an organisation address and a role; they are never logged and are kept as accounting records (legal obligation, Bokföringslagen, 7 years; `accounting_records`). Billing emails go to the invoice address; notices to club managers and treasurers, looked up when sending. Operators see clubs by name and country only. With card payments (part B) the payment provider (Stripe Payments Europe, Ireland; listed as sub-processor) receives the association's name, invoice email and card payment; webhook events are kept by ID only, 90 days. |

## Impact assessments

- Chat (Phase 2): [`dpia-chat.md`](dpia-chat.md) (children's safety in
  mixed environments, unlimited retention; ADR 0047).

## Legal bases (typical, club can adjust)

| Processing | Basis |
|---|---|
| Membership register, activities, attendance | Contract (membership) / legitimate interest |
| LOK-stöd and grant reporting | Legal obligation / legitimate interest (grant rules) |
| Background-check status | Legal obligation / legitimate interest; Art. 10 data → only metadata stored |
| Photos/video publication, streaming | Consent (guardian consent for children below consent age) |
| Newsletters to non-members | Consent |
| Salary | Contract + legal obligation |

## Data subject rights (self-service)

- **Access / portability (Art. 15 and 20, P1.8b):** "Download my data" on
  `/me/privacy` (the app opens it): a ZIP with `data.json` (versioned
  schema, [docs/api/data-export.md](api/data-export.md)) and a
  self-contained `index.html` in the requester's language, for the person
  or a ward of a full guardian, ready within minutes (`privacy:export` in
  the API's job runner). It holds the person, the account and settings,
  push devices (never tokens), family links, the inbox of the last 90
  days, and per club the profile, memberships, groups, roles, employments,
  consents with the text agreed to, applications, waiting lists, answers,
  attendance, call-ups, event sign-ups (sealed answers decrypted into this
  file only), invitations sent and the record history of the person's own
  rows. Other people are named only as the requester may see them. Not
  included: the clubs' notes (the README says to ask the club), other
  people's contact details, IP hashes, backups. Only the requester
  downloads it, with a recent login, through a five-minute link, for seven
  days; three requests a day.
- **Rectification:** person edits own profile; club managers edit club-specific data.
- **Erasure:** person can leave a club; leaving schedules deletion of club-specific
  data after the club's retention period (records required by law, e.g. accounting
  or grant reports, are kept in minimised form). Full account deletion anonymises
  the person everywhere: `people` row anonymised, messages kept as
  "deleted user" if the room requires history, otherwise deleted. The person's
  values are also scrubbed from the record history (the fact that a change
  happened is kept). The database function `privacy.erase_person` does this
  for the data that exists so far (people row: names emptied, birth date kept
  as the year, identity number, phone and address removed; login email
  replaced; club notes and emergency contacts; invitations; notifications
  and push devices, and the person removed from others' notices; record
  history)
  and records the person in the deletion ledger; it is idempotent, so it is
  run again for every ledger entry after a restore (ADR 0030). Since P1.8a
  it also clears join request, waiting-list and guardianship notes, the
  invitations sent to the person's address and open consents.
  Leaving a club yourself (P1.8a, ADR 0041) ends the membership, groups,
  pending requests, waiting places, coming event registrations and
  consents; it is refused while the person holds a club role, a leader
  function or a group ownership (step down first) or has unsettled invoices
  from the club. "Remove my contact details now" purges the club's data at
  once. Former members are purged after the club's period and people
  without a login and without any relationship are erased after
  `ORPHAN_RETENTION_MONTHS` (worker `privacy:retention`, as
  `clubadmin_retention`).
  **Account deletion (Art. 17, P1.8b):** on `/me/privacy/delete` and in
  the app, after `ERASURE_GRACE_DAYS` (default 14) in which it can be
  cancelled; refused while the person (or a ward to be erased) holds a club
  role, a leader function or a group ownership anywhere, or owes a club
  invoices, each named with the club. The person chooses for each ward
  without a login whose only guardian with a login they are whether the
  ward is erased too. Then `privacy:erase` checks again, leaves every club,
  ends the guardianships, deletes export files, runs `privacy.erase_person`
  as `clubadmin_retention`, deletes the Zitadel user and revokes every
  session. A full guardian erases a ward without a login the same way; the
  other full guardians are told and may cancel. After a restore the ledger
  replay erases the person again.
- **Objection / consent withdrawal:** one click per consent; effects apply
  immediately (e.g. hidden from photo galleries and streams). Consents are
  given per purpose (photo, video, streaming, marketing, federation
  sharing, contact details to the team or the club), for the club's current
  text version, on `/me/privacy` and in the app (P1.8a). Legal basis:
  Art. 6(1)(a), Art. 8 for minors through the country pack's consent age.
- **Transparency:** each club has a privacy policy built from a versioned
  template and its settings; settings the board decides change only through
  a recorded decision, and the policy shows the decision each value rests
  on (P1.8a, ADR 0037). Members are told when it changes.
- Guardians exercise rights for children below the consent age; teenagers get
  increasing control as they approach adulthood (country pack rules).

## Retention defaults (Sweden, configurable)

| Data | Default |
|---|---|
| Former member's profile (retention: `former_member_profile`) | The club's `former_member_retention_months` after the last membership ended: default 24, between 6 and 120, decided by the club's board (P1.8a). Then contact details shared with the club, emergency contacts, the club's notes, consents and free text (notes on answers, join requests, waiting lists, sign-up answers) are cleared, also in the history; the member number, membership dates and type, groups and roles stay as facts for annual and grant reports (worker `privacy:retention`, `privacy.purge_former_member`). "Remove my contact details now" when leaving does the same at once |
| Answers and attendance (P1.5; retention: `attendance`) | The club's `attendance_retention_months` after the activity ended: at least 12 (the default), at most 120, a club setting (no page sets it yet; the club settings page will); a club that reports grants from its attendance sets it as long as the grant rules require (worker `attendance:retention`, [#18](https://github.com/SweRavn/ClubAdmin/issues/18)). Record history keeps the deleted rows for its own period |
| Event registrations (P1.6; retention: `event_registrations`) | As answers and attendance: the club's `attendance_retention_months` after the event ended (`attendance:retention`) |
| Answers to sensitive sign-up questions (health, allergies, medication; P1.6; retention: `sensitive_event_answers`) | 30 days after the event ended, then deleted (`app.purge_expired_event_data`); sealed with field-level encryption until then, shown only to organisers, the participant and guardians with `see_medical`, never in emails, logs or calendars |
| Accounting records: the service's invoices, credit notes, their lines and payments, the invoice PDFs (retention: `accounting_records`; `billing:retention`, yearly, billing on only) | 7 years after the end of the invoice's calendar year (Bokföringslagen); billing contact fields (invoice email, reference) are cleared when no records remain |
| Chat messages (retention: `chat_messages`, planned) | Until room deleted, or club rule (e.g. 2 years) |
| Background-check verification metadata (retention: `background_checks`, planned) | While role is held + 1 year |
| Audit log (retention: `audit_log`) | `AUDIT_RETENTION_MONTHS` (an installation setting, default 24, at least 12), deleted in batches by age (worker `audit:retention`, P1.8a) |
| Record history (retention: `record_history`) | 2 years (configurable); personal values scrubbed on erasure |
| Join requests (decided) and invitations that can no longer be used, with their acceptances (retention: `join_requests`) | 12 months after the last change (worker `joining:retention`, P1.1); pending requests and usable invitations stay |
| Waiting-list entries (closed: declined, expired, admitted, withdrawn, removed) (retention: `join_requests`) | 12 months after they closed (`decided_at`, else the last change; worker `joining:retention`, P1.10b). Open entries stay while the application is open. Legal basis: the application, steps before a membership at the data subject's request. Owners see the applicant's name, birth year, the fit with the group's birth years and gender category, the requester, the notes and the waiting time, never contact details of non-members; `owner_note` is never shown to the applicant but is part of "download my data" |
| Member register export files (P1.2; retention: `member_export_files`) | 24 hours (worker `members:expire_exports`; the bucket's lifecycle rule deletes `exports/` after two days as a backstop); only the requester can download them, through a pre-signed link valid five minutes |
| Member register export records (who, when, which columns and filter, row count; no values) | Kept as part of the audit trail, like the audit log |
| Member import files (P1.3b) | Deleted as soon as they are read (the bucket's lifecycle rule deletes `imports/` after two days as a backstop) |
| Member import staging rows (the file's values, personal identity numbers sealed; retention: `member_import_rows`) | Seven days after the import ends or is cancelled; an import left in review for seven days is cancelled (worker `members:purge_imports`). The import record (who, when, counts) is kept like the audit log |
| Emails from an import file | Never stored on people (ADR 0020): only in the invitations sent (guardian and own-login invitations, deleted with them) |
| Guardian and own-login invitations that were never accepted (P1.3; retention: `unaccepted_invitations`) | 12 months after they expired or were revoked (worker `joining:retention`); accepted ones stay as the record of the guardianship or login |
| Merges (`people_merges`) | The record and what was moved stay for the 30-day undo period, then as the record of the merge (audit trail) |
| Invitation email addresses | With the invitation (above); never logged, never in outbox or job payloads |
| "Download my data" files (P1.8b; retention: `data_export_files`) | Seven days after they are ready (worker `privacy:expire_exports`, hourly; the bucket's lifecycle rule deletes `data-exports/` after eight days as a backstop); only the requester downloads them, through a five-minute link |
| "Download my data" requests (IDs, status, size; retention: `data_export_requests`) | 12 months, as the record that an access request was answered (worker `privacy:retention`) |
| Account deletion and ward erasure requests (IDs, dates, status; retention: `erasure_requests`) | 24 months after they ended (worker `privacy:retention`); the deletion ledger keeps the fact of the erasure |
| Notifications (P1.7): the inbox (retention: `notifications`) | 90 days after the notice was created (worker `notifications:retention`); texts hold no names (people are shown through the presenter when read) |
| Notification deliveries (which channel, when, provider ticket; no texts or addresses; retention: `notification_deliveries`) | 30 days |
| Push devices (sealed Expo push token, platform; retention: `push_devices`) | Until logout, Expo reports the token unregistered, or 90 days after last use |
| People without a login and without any relationship (retention: `orphaned_people`) | Kept `ORPHAN_RETENTION_MONTHS` (an installation setting, default 36, at least 12) after their last relationship ended and every club purged them, in case a club or a guardian links them again; then erased (`privacy.erase_person`, worker `privacy:retention`). A new relationship clears the mark. Accounts with a login are never erased automatically (P1.8a) |
| Profile view log (P1.12: who opened whose profile, per club, viewer, viewed person and day, with a count; IDs, dates and counts only; retention: `profile_views`) | 24 months after the last view (worker `privacy:profile_views`, daily). Views of protected people are always logged, every view in a club that chose "log every profile view". Legal basis: the club's legitimate interest in securing its register (for protected people also the duty of care); members are told on the profile pages. When someone no longer has any relationship to a club (no membership, also of a ward, role, group function or employment), the club's rows stop naming them, as viewer or viewed (`privacy:anonymize_profile_views` and the daily catch-up); erasure does the same in every club |
| Anonymisation ledger (P1.12: person and club IDs of anonymisations, applied again after a restore like the deletion ledger and exported next to the backups; retention: `anonymization_ledger`) | 13 months, longer than any backup (worker `privacy:profile_views`) |
| Calendar subscriptions (P1.11: owner, scope, label, the hash of the secret, last fetch; retention: `calendar_feeds`) | Until the owner removes or replaces them; a feed no calendar app fetched for 12 months is revoked and the owner told; revoked feeds are deleted 30 days later (worker `calendar:retention`). Only the SHA-256 hash of the secret is stored (redacted in the history); feed and answer-link paths are redacted from logs and traces. Feeds carry no attendee names, only the owner's own family by name (protected wards as initials) |
| Restorable club profiles (retention: `restorable_club_profiles`, planned) | Deferred from P1.8 |
| Backups (retention: `backups`) | ≤ 12 months, then destroyed (deletion ledger re-applied on restore; the ledger export next to the backups holds erased person IDs only) |

## Protected identity

People with protected personal data are hidden from other members, excluded
from public pages, photos and streams, have no stored postal address, and every
view of their profile is logged. See `domain-model.md` and ADR 0022.

The profile view log (P1.12) is personal data about the viewer and the viewed
person. Legal basis: the club's legitimate interest in securing its register
(for protected people also the duty of care). Members are told on the profile
pages when views are logged; the person and their full guardians can read who
opened their profile. Only IDs, dates and counts are stored, never what was
shown. Rows naming someone who left the club are anonymised (also again after a
restore, through the anonymisation ledger); retention in the table above.

## Children

- Default privacy settings for minors are the strictest: no public profile,
  no name in public pages or streams without guardian consent.
- Safe communication rules (see `domain-model.md`).
- Streaming and photos of children require explicit consent per child; the
  stream UI shows which participants lack consent.

## Hosting location

Hosted service: all personal data processed and stored in the EU/EEA, using
EU-headquartered providers where feasible. No analytics trackers; first-party,
cookie-less, aggregated metrics only. No third-party ad networks.
