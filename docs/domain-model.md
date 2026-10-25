# Domain model (core)

This covers the core that everything else depends on: people, accounts, clubs,
groups, memberships, roles, guardianship, waiting lists and protected identity.
Feature modules (activities, chat, finance, …) document their own entities in
their prompts and extend this file.

## Key ideas

1. **A person exists once in the system.** One human = one `person` row, no
   matter how many clubs they belong to. Identified internally by a generated
   ID, never by email (ADR 0020).
2. **Email is the login, and only people who log in have one.** A login email
   is unique across the whole system. Children without a login have **no email
   at all**; their guardians are contacted instead.
3. **Everything a person *is* in a club is a relationship** with a validity
   period: membership, role, group function, employment, guardianship.
   Ending a relationship sets `valid_to`; history is kept (needed for LOK-stöd,
   annual reports, audit) until the retention period expires.
4. **Clubs see only what they need.** A club sees the person's profile fields
   that the person (or guardian) has shared with it.
5. **Groups, not just teams.** Clubs organise themselves differently: teams,
   training groups, age groups, sections, committees. All are `groups`
   (ADR 0019). The UI label is configurable per club and kind ("Lag",
   "Träningsgrupp", …).
6. **Protected identity overrides visibility everywhere** (ADR 0022). Every
   API response that mentions a person goes through one visibility service.

## Entity overview

```mermaid
erDiagram
  ACCOUNT |o--|| PERSON : "logs in as (optional)"
  PERSON ||--o{ CLUB_MEMBERSHIP : has
  CLUB ||--o{ CLUB_MEMBERSHIP : has
  CLUB ||--o{ GROUP : has
  GROUP ||--o{ GROUP : "parent of"
  CLUB ||--o{ SEASON : has
  GROUP ||--o{ GROUP_MEMBERSHIP : has
  PERSON ||--o{ GROUP_MEMBERSHIP : has
  GROUP ||--o{ WAITLIST_ENTRY : has
  PERSON ||--o{ WAITLIST_ENTRY : "queues in"
  PERSON ||--o{ CLUB_ROLE_ASSIGNMENT : holds
  CLUB ||--o{ CLUB_ROLE_ASSIGNMENT : grants
  PERSON ||--o{ GUARDIANSHIP : "is guardian in"
  PERSON ||--o{ GUARDIANSHIP : "is ward in"
  PERSON ||--o{ CLUB_PROFILE : "shares with club"
  CLUB ||--o{ CLUB_PROFILE : sees
  CLUB ||--o{ EMPLOYMENT : employs
  PERSON ||--o{ EMPLOYMENT : "employed as"
  PERSON ||--o{ CONSENT : gives
  PERSON ||--o{ CALENDAR_FEED : owns
  CLUB ||--o{ LOCATION : has
  CLUB ||--o{ ACTIVITY_SERIES : plans
  ACTIVITY_SERIES ||--o{ ACTIVITY : "has sessions"
  ACTIVITY }o--o{ GROUP : "for (activity_groups)"
  LOCATION |o--o{ ACTIVITY : "takes place at"
  CLUB ||--o| SUBSCRIPTION : "billed by (optional)"
```

## Entities

### `people` (global)
`id` (UUIDv7), `given_name`, `family_name`, `birth_date` (age rules: LOK,
child protection, consent age; unknown for people who signed up themselves
until onboarding asks, P1.1), `gender` (optional, some grant reports),
`personal_identity_number` (optional, encrypted, country-specific format,
stored as `<country>:<normalised number>` ciphertext),
`personal_identity_number_hash` (keyed blind index for finding duplicates),
`protected_identity` (bool, see below), `phone`, `address` (both optional;
address is never stored for protected persons, check constraint),
`deceased_at`, `anonymized_at`, `merged_into_person_id` (set on a merged
duplicate), `created_by_person_id`.
**No email column.** Email belongs to the account.

### `accounts` (global, optional per person)
Login identity: `person_id` (unique), `email` (unique, case-insensitive,
stored normalised: trimmed, lower-case), `email_verified_at`, `idp_subject`,
`locale`, `time_zone`, `theme`, `notification_settings`.
No password data (that lives in Zitadel).
- One account per person, one person per account.
- Changing email requires verifying the new address; the old address is
  notified.
- A guardian's email can never be attached to a child: uniqueness makes this
  impossible, and there is no "contact email" field on persons to put it in.

### Children without login, and giving them one later
- A guardian adds a child via **"Add child"**: name, birth date, optional
  personal identity number. This creates a `person` with no account and a
  `guardianship` (`kind = parent`) to the creator.
- The second guardian is **invited by email** to become guardian; they accept
  with their own account. A club manager or registrar can also confirm or add
  guardianships (e.g. from a paper application).
- The second guardian's invitation is a `guardian_invitations` row
  (`ward_person_id`, `invited_by_person_id`, `email`, `token_hash`, `kind`,
  `rights`, `expires_at`, `accepted_at`, `accepted_by_person_id`,
  `guardianship_id`, `revoked_at`); accepting creates the guardianship.
  An invitation sent by a club when it adds or imports a member (P1.3b)
  also has `club_id` (the email names the club and why; the club's managers
  and registrars see it) and, for linked kinds, the club's `consent_note`;
  the guardianship it creates is recorded by that club. Whoever accepts
  with the invited email becomes the guardian, with an existing login or a
  new one: a child is never linked to an existing account automatically.
- Duplicates (both parents created the same child) are merged by a guardian
  of both, or by a club manager for two members of their club; matching on
  birth date + name or personal identity number. Merges are audited and
  reversible for 30 days (`people_merges`: kept and merged person, who
  merged, `undo_until`, `undone_at`, and every moved or ended reference).
  The duplicate's relationships move to the kept person; where the kept
  person already has the same open relationship, the duplicate's is ended.
  The duplicate stays as a stub with `merged_into_person_id`. A person with a
  login cannot be merged away (merge into them instead). A club manager's
  merge (with a second factor) moves the global rows and the rows of that
  club only; the duplicate's rows in clubs the manager cannot see stay with
  the stub, and the families merge them as guardians of both (by design,
  [#5](https://github.com/SweRavn/ClubAdmin/issues/5)).
- **Duplicate detection** (P1.3) is computed, never stored: same birth date
  and family name (`people_duplicate_idx`) or the same personal identity
  number hash (`people_pin_hash_idx`). For a guardian
  (`GET /me/duplicates`, `app.family_duplicate_candidates()`): pairs of one
  of their wards and another ward of theirs or of their full co-guardians;
  a pair is listed only if the guardian may see both people (a protected
  duplicate of a co-guardian stays hidden), and "Merge" only for a full
  guardian of both. For a club (`GET /clubs/{clubId}/duplicates`, managers
  and registrars): pairs of its members, keyset-paged.
- **"Give own login"**: when the child reaches `own_account_min_age` (country
  pack, default 13), a guardian (or the club) enters the child's own email. An
  invitation goes to that address; when the child completes sign-up, the
  account is linked to the existing person — all history, memberships and
  groups are kept. The invitation is an `account_invitations` row
  (`person_id`, `email`, `token_hash`, `created_by_person_id`, `expires_at`,
  `accepted_at`, `revoked_at`); the account must be created with that
  (verified) email. The link's token is derived from the invitation's ID
  with `INVITATION_TOKEN_KEY` (the worker emails it); a daily job tells each
  full guardian once when a ward without login reaches the age. Guardians
  keep their rights until `adult_age`; then the young person decides which
  guardian access continues (below).
- **Adult decision** (P1.3): the worker flags each open guardianship when
  the ward reaches `adult_age` of the strictest country pack of the ward's
  clubs (the default country without clubs). The young person (with their
  own login) chooses per guardian `keep` or `end` (`adult_decision`,
  `adult_decided_at`), once; ending tells the guardian by email that access
  ended, not why. A young person with their own login cannot end a full
  guardian's guardianship before that.
- Messages for a child without account go to guardians with
  `receive_messages`.

### `clubs`
`id`, `name`, `short_name`, `slug`, `country`, `default_locale`, `time_zone`,
`currency`, `organization_number`, `federation_ids` (JSON, e.g. IdrottOnline),
`address`, `logo`, `status` (active, suspended, archived), `join_policy`,
`next_member_number` (for the per-club running member number),
`owners_can_appoint_co_owners` (default off), `group_owners_admit_to_club`
(default on).

### `club_profiles`
What a club sees about a person: **member number** (running number per club,
human-friendly, shown on lists and exports; assigned by a trigger under the
club row's lock), `shared_fields` (which of the person's own fields, such as
phone or address, the club may see), `emergency_contacts`, `notes`
(restricted), `protected_identity_club` (club-set protection flag, see
below). Photo and other consents are rows in `consents`. The profile is
created with the first membership and kept when the person leaves.

### `club_memberships`
Person ↔ club. `status` (active, paused, left; `applied` is legacy, no
longer written, see below), `membership_type` (active, supporting, honorary,
family), `valid_from`, `valid_to` (set exactly when `status = left`). Joining
follows `join_policy`: `open` → active at once, `approval` → a join request
the club decides, `invite_only` → only by invitation. Leaving also ends the
person's group memberships, ownerships and roles in the club. Registrars and
club managers pause, resume and end memberships and change their type in the
member register (P1.2, `PATCH /clubs/:clubId/members/:personId/membership`);
ending one on an earlier day sets `valid_to` to the end of that day in the
club's time zone (its groups and roles end at once), and the last club
manager's membership cannot end.

### The member register (P1.2)
`app.register_entries` lists, per club, everyone who is or was a member, with
their current membership (or their last, if they left); `applied` is never
listed. It joins people only through the club's memberships and profiles
(tenant row-level security), and its `visible` column is the database
backstop for protected identity: pages contain only rows the viewer may see;
counts may include protected members without identity (not for a name
search, which would reveal them). Search matches part of "given family" name
(trigram index) or the member number. Filters: status (default active and
paused), membership type, group, club role, birth year range, gender (only if
shared with the club), missing consent. Access (`registerAccess`): **full**
for club managers and registrars (every field the profile shows them, plus
roles and missing consents; protected members marked), **limited** for the
board roles `chair`, `vice_chair`, `treasurer`, `secretary`, `board_member`,
`deputy_board_member` (name, member number, membership type, groups; only
the name, type and group filters; never protected members).

### `member_exports`
A CSV export of the register (club-owned): `requested_by_person_id`, `status`
(queued, ready, failed, expired), `filter` (the register filter: IDs and enum
values only), `columns`, `include_protected`, `row_count`, `object_key`
(`exports/<club_id>/<id>.csv` in the files bucket), `expires_at` (24 hours
after it is ready), `error_code`. The insert trigger queues the worker job
(`members:export`), which writes the file in batches to object storage in the
requester's language (UTF-8 with byte order mark, formulas neutralised,
protected members only when included, then marked "do not share") and fails
the export if the requester has lost the role. Only the requester downloads
it (a pre-signed link valid five minutes); `members:expire_exports` deletes
the file after 24 hours and keeps the row as a record.

### Adding and importing members (P1.3b)
Registrars (and club managers with a second factor, `club.members.add`) add
a member by hand: the person (no email, ADR 0020), the profile (the fields
given are shared with the club; protected identity is the club-level flag
and no address is stored), the membership (type, a start date in the past),
groups, any number of guardians (a member of the club, a new person without
login, or an email invitation from the club), and an adult's own-login
invitation; a minor's email is refused. One transaction through the
services.

Imports (`club.members.import`: registrars and club managers, always with a
second factor; confirming needs a login within 15 minutes; ADR 0033):

- `member_imports` (club-owned, record history with the headers redacted):
  `created_by_person_id`, `status` (`uploaded`, `parsing`, `review`,
  `importing`, `done`, `failed`, `cancelled`), `source_format` (`csv`;
  `xlsx` is refused), `detected_source` (e.g. `idrottonline`), `columns`
  (headers, a sample and the suggested field per column), `column_map`,
  `options` (default membership type and start date, member numbers kept or
  assigned, invitations, the consent note for linked guardians), `counts`
  (rows, new, duplicate, error, skipped, imported, guardians, invitations),
  `object_key` (`imports/<club_id>/<id>` until parsed), `error_code`,
  `confirmed_by_person_id`, `confirmed_at`, `finished_at`, `purged_at`.
  Person references in `members.references.ts`.
- `member_import_rows` (club-owned, no record history): `row_number`, `cells`
  (the file's row, sealed with the club's key), `data` (the mapped values;
  the personal identity number sealed separately with a blind index),
  `status` (`new`, `duplicate`, `error`, `skipped`, `imported`), `issues`
  (codes, never values), `family_key`, `match_person_id`, `resolution`
  (`same_person`, `different_person`), `skipped_by_user`, `person_id`.
  Index `(import_id, row_number)`.
- Columns are recognised from Swedish, English and Norwegian headers and from
  the member systems of the club's country pack (IdrottOnline in `se`);
  guardians as numbered column groups (`Vårdnadshavare 3 e-post`, any number)
  or one row per guardian with a family key and a relation. Dates in ISO or
  the country's order (`02.04.2017`); `2/4/2017` only when unambiguous.
- Duplicates are looked for **in the club only**: the same identity number,
  or the same birth date and names (`already_in_club`: skipped, so a re-run
  of the same file skips every row), or the same birth date and family or
  given name (`possible_duplicate`: the registrar decides "same person",
  which adds the row's groups and guardians to the member, or "different
  person"). People outside the club are never compared or shown.
- A guardian with an email (and invitations chosen) gets a club invitation;
  the others become people without login, one person per name and phone in
  the file (siblings share their parents). A guardian with the same name and
  phone as a member of the club is linked to that member. A minor's email
  goes to a guardian without one, else it is dropped (`minor_email_moved`,
  `minor_email_dropped`).
- The run adds the confirmed rows in batches of 100 (each batch one
  transaction, each row all or nothing; a failed row is marked
  `import_failed`), as the confirming registrar, so every person, profile,
  membership, group membership and guardianship has its usual audit event.
  Audit events of the import itself: `members.import.started`,
  `.confirmed`, `.cancelled`, `.finished`; every club manager is emailed the
  counts when it finishes.
- Staging rows and any file are deleted seven days after the import ends
  (worker `members:purge_imports`); an import left in review for seven days
  is cancelled. The import record keeps its counts.

### `groups` (ADR 0019)
`id`, `club_id`, `parent_group_id` (optional hierarchy: section → team), `kind`
(`section`, `team`, `training_group`, `age_group`, `committee`, `board`,
`volunteers`, `other`), `name`, `sport`, `birth_year_from/to`,
`gender_category`, `level`, `capacity` (optional),
`admission_mode` (`direct` | `waitlist` | `closed`), `waitlist_visible_publicly`,
`offer_reply_days` (default 7), `archived_at`.
Groups persist across seasons; `seasons` (`name`, `starts_on`, `ends_on`)
and `group_seasons` (`capacity`, `notes`) hold per-season settings. Groups are
archived, never deleted.
Multi-sport sections are groups of kind `section`; the earlier
`section_admin` role is simply an owner of a section group.

### `group_memberships`
Person ↔ group with a **function**: `member` (player/participant),
`head_coach`, `assistant_coach`, `team_manager`, `physio`, `other_leader`.
A person can hold several functions in the same group (separate rows).
`valid_from`/`valid_to`.

### `group_owners`
Person ↔ group, administrative ownership: edit the group, manage its members
and functions, run its waiting list, manage its chat rooms and calendar.
- A group can have **several owners** (or none; club managers can always act).
- **Club managers assign and remove group owners.** Club setting
  `owners_can_appoint_co_owners` (default off) lets owners add co-owners.
- Ownership of a parent group (e.g. a section) includes its child groups.
- Ownership is independent of being a coach: often the same person, not always.
- `group_owners`: `group_id`, `person_id`, `assigned_by_person_id`,
  `valid_from`, `valid_to`.

### Waiting lists (ADR 0019)
`group_waitlist_entries`: `group_id`, `person_id`, `requested_by_person_id`
(e.g. guardian), `status` (`waiting`, `offered`, `accepted`, `declined`,
`expired`, `admitted`, `withdrawn`, `removed`), `queued_at`,
`priority` (optional: e.g. sibling, returning member), `offer_expires_at`,
`applicant_note`, `owner_note` (owners only), `out_of_order_reason`,
`decided_by_person_id`, `decided_at`. (Schema since P0.5; behaviour P1.10.)
- **Getting on the list:** a member (or guardian for a child) applies to a
  group that is full or has `admission_mode = waitlist`. Non-members can join a
  waiting list from the club's public page after signing up; this also creates
  a club join request.
- **Order:** priority, then `queued_at`. Applicants see their own position
  ("you are number 3"); owners see the full list with filters (birth year,
  gender category, waiting time).
- **Admitting:** an owner either admits directly or sends an **offer** that the
  person/guardian accepts or declines within `offer_reply_days`. Expired
  offers move on automatically to the next person if the owner enabled
  auto-offers.
- Admission creates the group membership and, if the person is not yet a club
  member, the club membership (club setting `group_owners_admit_to_club`,
  default on; otherwise a manager/registrar approves).
- **Fairness:** admitting someone out of order requires a reason, which is
  audited and visible to club managers.
- A person can be on several waiting lists at once.
- Closed entries are deleted after 12 months (retention).

### `club_role_assignments`
Club-level roles: `chair`, `vice_chair`, `treasurer`, `secretary`,
`board_member`, `deputy_board_member`, `auditor`, `nomination_committee`,
`club_manager`, `registrar` (membership/LOK), `safeguarding_officer`,
`communications`, `staff`. Validity period; `assigned_by_person_id`,
`ended_by_person_id`.

**Club managers** (ADR 0018) have full administrative rights in the club. A club
can have several; there must always be at least one active manager. The person
who creates a club becomes its first manager. Managers appoint/remove other
managers; handing over is "appoint successor → successor accepts → step down".
Proposals are `club_manager_handovers` (`from_person_id`, `to_person_id`,
`status`: proposed, accepted, declined, cancelled; `expires_at`, 14 days);
one open proposal per manager, a new one replaces it. Accepting makes the
successor manager and ends the proposer's role in one transaction.

### Sign-up and joining (ADR 0018, ADR 0032; P1.1)
- Anyone can sign up (verified email) without an invitation; this creates an
  `account` + `person` with no club yet. Before any club action the person
  completes their profile (birth date, for age rules; `PUT /me/profile`).
- `clubs.join_policy`: `open` | `approval` (default) | `invite_only`.
  `invite_only` clubs are not listed in the club search and answer "not
  found" to join requests.
- `join_requests` are **the only record of an application**: a person (and
  optionally their children, as a guardian with `act_on_behalf`) asks to
  join, with status `pending`/`approved`/`rejected`/`withdrawn`, decided by a
  manager or registrar (later also by a group owner admitting from a waiting
  list, P1.10). Approving creates the active membership in the same
  transaction; accepting an invitation settles a pending request. Columns:
  `person_id`, `requested_by_person_id`, `message`, `preferred_group_ids`
  (a hint; the web form does not offer them yet, as outsiders cannot see a
  club's groups), `decided_by_person_id`, `decided_at`, `decision_message`.
  Migration 0007 turned the old `applied` memberships into pending requests.
- `invitations`: email, link or code invitations with group and role presets
  (role presets only by club managers), expiry and use limit (`kind`,
  `email`, `token_hash`, `role_preset`, `group_id`, `expires_at`,
  `max_uses`, `uses`, `accepted_by_person_id` (first acceptance),
  `revoked_at`). Only a hash of the secret is stored; email tokens are
  derived from the invitation ID (ADR 0032). `invitation_acceptances`
  records everyone who accepted a link or code.
- Club creation is governed by `CLUB_CREATION` (`open` | `approval` |
  `operators_only`; default open when hosted, operators only when
  self-hosted). With `approval`, `club_creation_requests` (global: the
  requester and platform operators; the club fields, `status`,
  `decided_by_person_id`, `decided_at`, `decision_message`,
  `created_club_id`) are decided by an operator; approving creates the club
  with the requester as its first manager.
- `club_manager_reassignments`: an operator appointing a manager on the
  club's documented request, with the reason (recovery, ADR 0018).
- Decided join requests and invitations that can no longer be used are
  deleted after 12 months (worker `joining:retention`, `docs/gdpr.md`).
- Not yet: abandoned-club handling ([#16](https://github.com/SweRavn/ClubAdmin/issues/16)),
  challenges and per-domain limits against abuse ([#15](https://github.com/SweRavn/ClubAdmin/issues/15)),
  mobile screens ([#17](https://github.com/SweRavn/ClubAdmin/issues/17)).

### `guardianships` (global, confirmed per club)
`guardian_person_id`, `ward_person_id`, `kind` (`parent`, `legal_guardian`,
`relative`, `contact_person`, `step_parent`, `foster_parent`), `rights` (flags: `act_on_behalf`,
`receive_messages`, `view_schedule`, `sign_up`, `see_medical`), `status`
(`pending`, `active`, `ended`; invitations are separate rows, see above),
`valid_from`, `valid_to`, `created_by_person_id`, `ward_adult_flagged_at`
(set by the worker when the ward reaches `adult_age` of their clubs' country
packs; the guardianship is not ended automatically), `adult_decision`,
`adult_decided_at`, `granted_by_person_id` (who chose a relative's or contact
person's rights), `recorded_by_club_id` and `consent_note` (a club recorded
it from a paper form), `ended_reason` (a club manager ended a full
guardian's guardianship; never in audit events), `own_login_age_notified_at`.
A ward can have any number of guardians (one open guardianship per guardian
and ward).
- `parent`/`legal_guardian` have full rights.
- **Relatives** (grandparent, older sibling, aunt) and **contact persons**
  (a neighbour who drives, a family-home contact, an LSS contact person or
  trustee of an adult) hold only the rights chosen per link: any of
  `view_schedule`, `receive_messages`, `sign_up`, `see_medical`; defaults:
  relative `view_schedule`, contact person `view_schedule` and
  `receive_messages`. **Step parents** (bonus parents) and **foster
  parents** (family homes, P1.3b) are linked kinds like relatives: rights
  per link, default `view_schedule`, never full guardians (a foster home's
  legal custody, if any, is recorded as `legal_guardian`). `act_on_behalf`
  only for relatives, step and foster parents, explicitly chosen by a full
  guardian, the adult ward or the club (with a warning in the UI); never for
  contact persons. Older clients show the new kinds as "Other" (ADR 0029).
  Each later feature enforces the right it needs (schedule P1.4, sign-up
  P1.5/P1.6, messages P1.7, medical notes later). P1.5: answering for a
  ward needs `sign_up`.
- Who links them: a full guardian while the ward is under `adult_age`; the
  ward themselves from `consent_age` (with their own login; acting on
  behalf only from `adult_age`); a club's registrar or manager from a paper
  form with a consent note. The linked person is invited by email (accepted
  with their own login, the login email must match), chosen from the club's
  register (clubs only), or a new person without login (name, phone). A
  relative or contact person never links others or changes rights.
- Who ends them: the linked person themselves, a full guardian of a minor
  ward, the ward (from `consent_age`), or the club for links it recorded.
  Full guardians: only the guardian themselves, a club manager with MFA and
  a reason, or the young person's adult decision.
- What they see: the ward's name and what the rights allow; the guardians'
  names, never their phone numbers or invitations. Clubs see the links of
  their members like guardians (managers, registrars, the ward's group
  leaders). `club_profiles.emergency_contacts` stay for people the club only
  needs to call.
- A guardianship becomes visible to a club only when the ward is a member of
  that club.

### Protected identity (ADR 0022)
For people with protected personal data (in Sweden *skyddade
personuppgifter*: sekretessmarkering, skyddad folkbokföring), and anyone else
who must not be exposed.
- **Effective flag** = `people.protected_identity` (set by the person, or by a
  guardian for a child; applies in all clubs) **or**
  `club_profiles.protected_identity_club` (set by a club manager when the club
  has been informed; applies in that club).
- Only the person/guardian (global flag) or a club manager (club flag) can
  remove it; every change is audited and notifies club managers.
- **Who can see a protected person:** the person, their family (guardians and
  wards), club managers, registrars, and the owners (including owners of parent
  groups) and leaders of groups the person belongs to (they must run
  activities and take attendance). They see a **camera-with-strike-through
  icon** next to the name, meaning: do not photograph, film, publish or share.
  Platform operators with support access never see them.
- **Everyone else sees nothing:** not in member lists, group rosters,
  attendance/response lists, event participant lists, car pools, search,
  history/audit actor names, chat member lists, photos or streams. Counts may
  include them ("12 attending") without identity.
- **Chat and other shared spaces:** never added automatically. They (or their
  guardian) get an invitation and appear only in rooms they explicitly accept,
  optionally under a chosen display name.
- **Data minimisation:** no postal address stored; no public profile; never
  in public pages, streams, photo galleries or sponsor material; excluded from
  exports to other members. Federation exports (e.g. LOK-stöd) follow the
  country pack's rules for protected persons.
- **Guardians of a protected child** are prompted to protect themselves too
  (a parent's name can reveal the child).
- **Access logging:** every view of a protected person's profile is logged.

### `employments`
Person employed by a club: `title`, `starts_on`/`ends_on`, `employment_type`
(permanent, fixed_term, hourly, volunteer_stipend), `hours_per_week`. Salary data
lives in the `staff` module (later phase) with stricter access.

### `consents`
Purpose-based consents (photo/video publication, streaming, marketing, data
sharing with federation). Given by the person or, for minors under the
country's consent age, by a guardian. Timestamped, versioned text, revocable
(`purpose`, `text_version`, `given_by_person_id`, `given_at`, `revoked_at`,
`revoked_by_person_id`; one open consent per purpose).

### Activities and "My schedule" (P1.4, ADR 0034)
- `locations` (club-owned): name (unique among the club's unarchived
  locations, case-insensitive), address, optional coordinates (both or
  neither; the map link is OpenStreetMap), directions. Archived, never
  deleted; archived locations are not offered for new activities.
- `activity_series`: a weekly series of a club's groups
  (`activity_series_groups`): kind, title, notes, leader notes, location or
  free-text place, slots (ISO weekday, local start time, length; one per
  weekday), first and last date (at most 400 days), skipped dates and
  whether the country pack's public holidays are skipped. Every session is
  created with the series.
- `activities`: a single activity or a session of a series (`series_id`,
  `occurrence_on` = its local date, unique per series). Kind (`training`,
  `match`, `meeting`, `other`), title, start and end (UTC; `all_day`),
  meeting time and place, location or free-text place, `status`
  (`scheduled`, `cancelled` with a reason shown to everyone), notes (the
  groups), leader notes (only those who manage it), match fields
  (`opponent`, `home_away`, `competition`), `detached` (edited apart from its
  series: series changes leave it alone), `sequence` and `changed_at`
  (every change a calendar must show). Its groups are `activity_groups`
  (one or more, same club; a joint training names each group, there is no
  inheritance down the group tree).
- `schedule_entries`: the read model of calendars and "My schedule", one
  row per activity and group with what they show (no people), written in
  the same transaction as the activity. "My schedule" is the entries of the
  reader's open group memberships and those of their wards with
  `view_schedule` (only the ward when acting on behalf), across clubs:
  joining or leaving a group, or a revoked right, takes effect at once. No
  record history (derived data).
- Changing a series applies from a date (never in the past); "this and
  following" ends the series the day before a session and starts a new one
  with the changes. Deleting a session skips its date in the series. Past
  sessions are never rewritten (attendance, P1.5). A session with answers
  or attendance is never deleted: deleting it is refused, and a series
  change that drops it cancels it (ADR 0035).
- Calendars never list participants (ADR 0021): the activity page shows the
  leaders of its groups through the person presenter.

### Responses and attendance (P1.5, ADR 0035)
- `activities.response_mode` (`none`, `optional`, `requested`; by kind:
  trainings optional, matches and meetings requested, other none) and
  `respond_by`; a series has the mode and `respond_by_minutes` before each
  session. Until the deadline any answer, after it only "not attending";
  cancelled or ended activities take no answers.
- **The roster** of an activity is who was in its groups on its start
  (`group_memberships` valid at `starts_at`): members are participants,
  the other functions leaders. With a call-up (`activities.invitees_only`,
  ADR 0036) the participants are only the members called up
  (`activity_invitees`: club-owned, one per activity and person, IDs and
  who called them up; readable across clubs by the person and their
  guardians for "My schedule", which leaves the activity out for members
  not called up). Those who manage the activity set it; answers of people
  no longer called up are kept and not counted.
- `activity_responses` (club-owned): one per activity and person on the
  roster: `status` (`attending`, `not_attending`), `note` (to the leaders,
  200 characters, may be about health: only the leaders and the person's
  family see it), `responded_by_person_id` (the person or a guardian with
  `sign_up`; full guardians hold every right), `responded_at`. Readable
  across clubs by the person and their guardians (`own_read`, for "My
  schedule").
- `attendance_records` (club-owned): one per activity and person:
  `status` (`present`, `absent`, `excused`), `role` (`participant`,
  `leader`), `guest` (a club member not on the roster),
  `recorded_by_person_id`, `recorded_at` (the device's time; the newer mark
  wins), `corrected_reason`. Leaders record from an hour before the start
  until `clubs.attendance_lock_days` (default 30) after it; then club
  managers and registrars correct, with a reason. Never deleted, except by
  the retention job.
- Counts include protected members; names of those attending are shown
  only to viewers who may read the group's roster, through the person
  presenter (protected members are counted, never named, for others).
- Legal basis: the membership (running the activity) and, for attendance,
  the club's grant reporting. Both are kept for the club's
  `attendance_retention_months` (at least 12, default 12, at most 120) after
  the activity ended, then deleted by the worker (`attendance:retention`;
  the activity stays); erasure removes the notes on a person's answers.
- Grant rules per session come from the country pack (`se`: LOK-stöd, at
  least 45 minutes, three participants aged 7–25, a leader of 13 or more);
  the leaders see them as hints.

### Events with sign-up (P1.6, ADR 0038)
- `events` (club-owned): a sign-up container for some groups
  (`event_groups`) or the whole club (`audience`), `status` (`draft`,
  `published`, `cancelled` with `cancelled_reason`), the period, a place,
  `price_text` (no payments before Phase 3), `registration_opens_at`
  (null: when published), `registration_closes_at`,
  `cancellation_closes_at` (null: the same), `capacity` (null: unlimited),
  `waitlist_mode` (`none`, `auto`, `offer`; default `offer` for group
  events, `auto` for club events), `offer_reply_hours` (default 24) and
  `questions` (JSONB, at most 20: `{ id, type, label, required,
  sensitive, options? }`, types short and long text, one or several
  choices, number, yes/no).
- `event_activities` (club-owned): the event's activities (an activity
  belongs to at most one event). Each is called up (ADR 0036) to exactly
  the confirmed participants; unlinking lifts the call-up. Cancelling the
  event cancels them.
- `event_registrations` (club-owned): one open registration (`confirmed`,
  `waitlisted`, `offered`) per event and person; ended ones (`cancelled`,
  `declined`, `expired`, `removed`) stay. `registered_by_person_id` (the
  person or a guardian with `sign_up`), `queued_at` (the queue's order),
  `offer_expires_at`, `answers` (JSONB, non-sensitive questions),
  `sensitive_answers` (sealed with field-level encryption: shown only to
  organisers, the participant and guardians with `see_medical`),
  `decision_reason`, `decided_by_person_id`, `decided_at` (organisers'
  out-of-order moves and removals). Readable across clubs by the person
  and their guardians (`own_read`, for "My events").
- Places: every change locks the event row and counts confirmed and
  offered registrations; a freed place goes to the next in the queue in
  the same transaction (confirmed with `auto`, offered with `offer`).
  Offers past their time expire in the API's job runner
  (`events:expire_offers`), which offers the place to the next.
- Organisers: club managers; for group events those who manage every
  audience group; for club events also the board. The leaders of the
  audience groups and registrars read the registrations. Participants'
  names only for viewers who may read an audience group's roster; counts
  for everyone who sees the event.
- Retention: sealed answers are deleted 30 days after the event ends,
  registrations after the club's `attendance_retention_months`
  (`app.purge_expired_event_data`, run by `attendance:retention`); erasure
  clears a person's answers and scrubs them from history.

### `calendar_feeds` (ADR 0021)
Personal, secret, revocable iCalendar subscription URLs: `person_id`, `scope`
(`my_schedule` incl. children, `group`, `club_public`), `scope_id`,
`token_hash`, `include_children`, `last_fetched_at`, `revoked_at`.

### Record history (ADR 0017)
Every table has a trigger writing to `history.record_changes`: table, record
id, operation, changed columns with old/new values, actor, on-behalf-of,
request id, time. Every detail screen can show "who changed what, when".
Separate from `audit_events`, which record business-level actions. Actor names
pass through the visibility service, so protected persons appear as
"Protected member" to those not allowed to see them.

### Platform tables
`platform_operators` (`person_id`, validity; written only by operator
tooling), `support_access_grants` (club-owned: `operator_person_id`,
`granted_by_person_id`, `reason`, `expires_at`, `revoked_at`; time-limited,
club-approved access for support, P0.7), `subscriptions`, `plans`,
`invoices` (billing module, optional), `feature_flags`.

## Access in the database (ADR 0023)

Row-level security backs the authorization module: club-owned tables are
isolated by `club_id`; a person's own relationships (and their wards') are
readable in every club; `people`, `accounts` and `guardianships` are reachable
only by the person, their family and the clubs they belong to.

## Effective permissions (examples)

| Situation | Can |
|---|---|
| Owner of group G | Edit G, manage members and functions, run G's waiting list, manage G's chat rooms and calendar |
| `head_coach` of group G | Edit G's activities, take attendance, message G's members and their guardians, see contact details of G's members (including protected members, with icon) |
| `member` in G, age 15 with account | See G's schedule, respond, join G's chat rooms; sees other members except protected ones |
| `parent` of member P | Everything P can do, on P's behalf; add children; plus guardian-only rooms |
| `relative` of P with `view_schedule` | See P's schedule only |
| `treasurer` of club C | Club finance, fees; with MFA |
| `board_member` of C | Board documents, meetings; member list (limited fields) |
| `safeguarding_officer` / `club_manager` | Background-check status of leaders; with MFA |
| `club_manager` of C | Everything in C's administration: settings, roles (incl. other managers and group owners), members, join requests, waiting lists, history; with MFA |
| Signed-up person without club | Own profile, add children, search clubs, send join requests, join waiting lists, create a club (if allowed) |
| Platform operator | Nothing in club data, unless the club grants time-limited support access |

## Permissions (implemented policies)

The authorization module (ADR 0006, ADR 0025) has one policy per permission
(`packages/shared/src/permissions.ts`, policies in
`apps/api/src/modules/authorization/authorization.policy.ts`). "Insider" means
any current relationship with the club: active or paused member, a club role,
a current employment, unexpired support access (operators, with a second
factor), or guardian of an active or paused member. Without one, everything in
the club answers 404; with one but without the permission, 403. "Owner"
includes owners of parent groups; "leader" is any function except `member`.

| Permission | Resource | Allowed for |
|---|---|---|
| `club.read` | club | insiders |
| `club.settings.update` | club | club managers, with MFA |
| `club.roles.manage` | club | club managers, with MFA |
| `club.members.read` | club | the member register (P1.2): club managers and registrars (full), the board roles (limited); see "The member register" |
| `club.members.manage` | club | registrars; club managers with MFA (pause, resume, end, change type) |
| `club.members.export` | club | club managers and registrars, with MFA and a login in the last 15 minutes |
| `group.read` | group | insiders; archived groups only managers, registrars and owners |
| `group.update` | group | club managers, owners |
| `group.owners.manage` | group | club managers; owners if the club allows co-owners |
| `group.members.read` | group | managers, registrars, owners; for active groups also everyone in the group, guardians (with `act_on_behalf`) of its members, support access |
| `group.members.manage` | group | club managers, owners |
| `person.profile.read` | person (`?clubId`) | the person and their guardians with `act_on_behalf`; in the club: managers and registrars, owners and leaders of the person's groups, and (unless the person is protected) people in the same group, their guardians, support access |
| `person.profile.update` | person | the person, guardians with `act_on_behalf` |
| `person.protection.set` | person | global flag: the person, guardians with `act_on_behalf` (the service requires a parent or legal guardian); club flag (`?clubId`): club managers, with MFA |
| `person.guardians.read` | person (`:personId`) | the ward, any active guardian of the ward (relatives see names only, no invitations) |
| `person.guardians.manage` | person (`:personId`, or the ward of `:guardianshipId`/`:invitationId`) | full guardians with `act_on_behalf`, the ward themselves (the service allows relatives and contact persons only, from `consent_age`); never a relative, never on behalf of someone |
| `person.merge` | person (`:personId`, the kept person of `:mergeId`; `?clubId`) | a full guardian (the service requires one of both people); a club manager with MFA for two members of the club |
| `person.own_login.invite` | person (`?clubId`) | full guardians; club managers and registrars of a club the person is a member of |
| `club.guardians.manage` | club | club managers, registrars; ending a full guardian's guardianship only a club manager with MFA and a reason |
| `group.activities.read` | group | the group calendar (P1.4): club managers and registrars, owners, everyone in the group (any function), guardians of its members with `view_schedule` |
| `group.activities.manage` | group (not archived) | adding activities and series: club managers, owners, head and assistant coaches, team managers |
| `activity.read` | activity (`:activityId`, `:seriesId`) | readers of any of its groups (as `group.activities.read`); others in the club 403, outside it 404 |
| `activity.manage` | activity | those who manage every one of its groups (as `group.activities.manage`) |
| `club.activities.read` | club | the club calendar and double bookings: club managers, registrars, the board roles |
| `club.locations.manage` | club | club managers |
| `activity.respond` | activity | members of one of its groups and guardians with `sign_up` of one (P1.5); the controller limits whom (the caller, those wards), the service the roster |
| `activity.responses.read` | activity | the leaders' list of answers: those who manage one of its groups and `other_leader`; not physios, members or guardians |
| `activity.attendance.manage` | activity | taking attendance: as `activity.responses.read`, club managers and registrars; after the lock only club managers and registrars (corrections) |
| `group.attendance.read` | group | a group's attendance summary: its leaders and owners (also of parent groups), club managers, registrars |
| `ops.backup.read` | platform (the installation, no IDs) | platform operators (in a self-hosted installation its administrators), with MFA: `GET /api/v1/ops/backup-status` |
| `club.access_state.update` | club | platform operators, with MFA (read-only and suspended clubs, also with billing off) |
| `billing.plans.read` | platform | platform operators, with MFA (billing on only) |
| `billing.subscription.read` | club | club managers and treasurers; platform operators with MFA (billing on only) |
| `billing.subscription.manage` | club | platform operators, with MFA (billing on only) |
| `club.create` | platform | anyone logged in with `CLUB_CREATION` `open` or `approval` (then a request); only platform operators, with MFA, with `operators_only`. The service also requires a verified email and a completed profile |
| `club.creation.decide` | platform | platform operators, with MFA |
| `club.join_requests.manage` | club | club managers, registrars |
| `club.invitations.manage` | club | club managers, registrars (a role preset also needs `club.roles.manage`) |
| `club.handover.respond` | handover | the proposed successor (accept, decline) and the proposer (cancel); nobody else learns that it exists |
| `club.managers.claim` | club | the board chair, with MFA, when the club has no active manager |
| `club.managers.reassign` | club | platform operators, with MFA (reason recorded; no access to club data) |

Endpoints for "my" data (`/me`, `/me/clubs`, `/me/groups`, `/me/wards`,
`/me/preferences`, `/me/profile`, `/me/join-requests`,
`/me/club-creation-requests`, `/me/manager-handovers`, `/me/schedule`, and for families
`POST /me/wards`, `/me/trusted-people`, `/me/duplicates`,
`/me/adult-guardians`, accepting a guardian invitation and ending a
guardianship, where the service checks who may) need only a login; looking
up a guardian invitation by its link is public. So
do the club search, asking to join (the service checks each person is the
caller or a ward with `act_on_behalf`) and accepting an invitation; looking
up an invitation by its link or code is public. Appointing, removing and
handing over managers use `club.roles.manage`. `GET /me/clubs` lists, per club, the
club-level permissions the caller holds (for navigation; permissions that need
a second factor are listed without one, the endpoints still ask for it).
A guardian acting for a ward (`X-On-Behalf-Of`) is evaluated as the ward,
with the ward's memberships only (never their roles, ownerships, leader
functions or employments); history and audit record both.

### Field visibility

`GET /api/v1/people/:personId?clubId=` returns fields by relationship
(`profileAccess`). Phone, address and gender reach a club only if the person
shared them with it (`club_profiles.shared_fields`).

| Viewer | Fields |
|---|---|
| The person, guardian with `act_on_behalf` | everything: birth date, gender, phone, address, club profile (member number, membership, groups), guardians with phone numbers |
| Club manager, registrar | birth date; shared phone, gender and address; member number, membership, groups; guardians with phone numbers |
| Owner or leader of one of the person's groups | birth date, shared phone, member number, groups, guardians with phone numbers |
| Same group, their guardians, support access | name only (never a protected person) |

## Age and child-safety rules (configured per country pack)

- `consent_age` (SE: 13) for data processing based on consent.
- `own_account_min_age` (default 13) — younger children have no login and no email.
- `adult_age` (18) — guardians' default rights end.
- Chat: no one-to-one chat between an adult and a minor unless a guardian is a
  participant; leaders can moderate group rooms.
