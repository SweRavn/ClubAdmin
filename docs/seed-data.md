# Seed data and development login

Without a pilot club, development and testing rely on a realistic, deterministic
demo dataset. It must be loadable with one command and exercise the hard
patterns of the domain model.

## Commands

```
pnpm db:seed                         # load the "demo" scenario into an empty database
pnpm db:seed --if-empty              # the same, but do nothing if there is data already
pnpm db:reset                        # drop, recreate, bootstrap, migrate, seed demo (development only)
pnpm db:reset --scenario load        # 1,000 clubs, about 200,000 people (--size n clubs)
pnpm db:reset --scenario minimal     # one club, one group, three people
```

`pnpm dev` seeds the demo scenario on its first start (`db:seed --if-empty`).
`db:reset` takes about 7 seconds with the demo scenario (budget 15 s); the full
`load` scenario about 2 minutes (budget 10 minutes; CI seeds `--size 10`, the
nightly workflow the full size).

The demo content below is stored as JSON data files in `docs/demodata/`
(personas with fixed IDs, clubs, groups, relationships, history to replay;
see its README) and loaded by the seed runner in `apps/api/src/seed/`, which
writes through the domain services with the persona as actor (ADR 0026).
This document describes the same data in prose and tables; keep both in step.

- **Fixed IDs:** personas, clubs and groups have the IDs in the data files;
  generated people get IDs from a counter, so two runs give the same IDs.
- **Dates relative to today:** ages in the tables stay correct (birth dates are
  computed from them), and so the names of age-group teams follow the year:
  "F2017" is `F{year}` with the birth year of 9-year-olds.
- **History:** past relationships are written with the time they happened
  (`app.seed_time`), and their validity is backdated without history rows of
  its own. Only a database in seed mode (`app_meta.seed_mode`, written by
  `db:seed`/`db:reset` as superuser) honours this; production never has it.
- **Rows written directly** (waiting lists with their past offers and
  decisions, P1.10b: an entry outside the club is linked to its pending join
  request as applying does today; join requests, club invitations,
  consents, employments, support grants): rows are inserted in a transaction
  of the acting persona, so history records who did it. Johan's application
  last year goes through the join-request service (requested, then approved
  by Anna).
- **Joining (P1.1):** pending join requests (Camilla for Sofie in FIL, Henrik
  for Viktor in SVK), a rejected one (Gunilla in SVK, decided by Anna with a
  message) and Johan's approved one; Nora's email invitation to SVK; a link
  invitation to SVK (F2017 preset, 25 uses) and a code invitation to IKN,
  with fixed demo secrets that `pnpm db:seed` prints:
  `/join/demo-svk-strandviken-invitation-link` and the code `KNB7DEMA`.
  Karin's open hand-over to Peter in IKN shows in Peter's "In progress".
- **Families (P1.3):** Jonas's pending invitation as Nadia's second guardian
  and Anna's revoked invitation of Gunilla (relative of Elsa); the duplicate
  Elsa (Mikael added her again; Anna accepted as second parent) for the merge
  notice; Vera (13, no login) for "Give own login"; Tilde (18, IKN) with
  both guardianships flagged at the adult age; Nils, Alva's contact person
  without login linked by Sara; Bo, the LSS contact person Emma linked to
  herself; Petra, recorded by Johan from a paper application as Maja's
  mother and ended by Anna with a reason. The adult-age flags are set as the
  worker would (`guardianships:flag_adult_wards`).
- **The `load` scenario** is the documented exception to writing through the
  services: one set-based transaction as superuser, recorded as a system job.

The persona picker (`DEV_AUTH`) shows every demo persona, children without a
login too, with the description and tags from `docs/demodata/personas.json`.

Integration tests also build their own fixtures with the builders in
`apps/api/src/testing/`. The **matrix** scenario (`scenarios.ts`, P0.7) has
one person per kind of relationship for the permission tests: in club A a
section with a team, a club manager, a registrar, the section's owner, the
team's head coach, an adult member, a protected adult member, a child with a
parent and a relative (`view_schedule` only); club B's manager as the
outsider; and a platform operator without support access.

## Rules

- Seeding is **deterministic**: fixed UUIDs for the named personas and clubs
  (so tests and bug reports can refer to them), fixed Faker seed for generated
  extras, dates relative to "today" so the schedule always has past and
  upcoming activities.
- All emails use the reserved `.test` domain (e.g. `anna.lindqvist@example.test`),
  phone numbers from ranges reserved for fiction/testing. Personal identity
  numbers come only from official test-number sets (Skatteverket's
  *testpersonnummer* for SE, synthetic test numbers from Skatteetaten for NO),
  never random numbers that could belong to real people.
- The seed refuses to run against a database where `DEPLOYMENT_MODE=hosted`
  and `NODE_ENV=production`.
- Each feature module adds its own seed step (`apps/api/src/seed/steps/<module>.ts`,
  registered in `DEMO_STEPS` in `runner.ts`) and data file in `docs/demodata/`
  on top of the core personas, so the dataset grows with the application.
- No personal identity numbers are seeded yet: only official test numbers
  may be used, and they are added when a feature needs them. Phone numbers
  come from the range reserved for fiction (+46 70-174 06 05 to 06 99);
  Norwegian personas have none.

## Development login (`DEV_AUTH`)

With `DEV_AUTH=true` (only allowed when `NODE_ENV=development`), the web login
page shows a **persona picker**: a list of seeded people with their roles. One
click logs in as that person. No Zitadel needed for everyday development. A
banner shows "Development login — logged in as Anna Lindqvist". The API logs a
warning on startup and refuses to start with `DEV_AUTH=true` in production.

Optionally `pnpm dev:idp-sync` creates the same personas as users in the local
Zitadel (verified email, password `demo-password-123`) and links their
accounts (`accounts.idp_subject`), to test the real login flow: "Log in with
email" as `anna.lindqvist@example.test`. Idempotent; run it again after
`pnpm db:reset`. Development only (`NODE_ENV=development`, issuer
`*.localhost`).

## Demo scenario: clubs

| Club | Country / locale / TZ | Sport(s) | Join policy | Managers | Billing (if enabled) |
|---|---|---|---|---|---|
| **Strandvikens Volleybollklubb** (SVK) | SE / sv-SE / Europe/Stockholm | Volleyball | `approval` | Anna, Sara, Mats (three administrators); Peter was manager until last year; Linnea was **suspended** last week (P1.15 A3) | Paid plan, active |
| **IK Norrbacka** (IKN) | SE / sv-SE / Europe/Stockholm | Multi-sport: football + floorball sections | `open` | Karin, Göran (two administrators); hand-over from Karin to Peter **pending** his acceptance | Free plan |
| **Fjordvik Idrettslag** (FIL) | NO / nb-NO / Europe/Oslo | Handball | `invite_only` | Lars, Kari (exactly two: the recommendation of a third shows) | Trial, ends in 10 days |
| **Lövsta Bordtennisklubb** (Lövsta BTK) | SE / sv-SE / Europe/Stockholm | Table tennis | `approval` | Ulf alone, **within his grace period** (12 days left; P1.15 A3) | — |
| **Ekuddens Schackklubb** (Ekudden SK) | SE / sv-SE / Europe/Stockholm | Chess (club type **Schackklubb**, P1.15 B) | `approval` | Britt, Aron (two administrators) | — |

SVK has contact details (P1.6b, `contact` in `docs/demodata/clubs.json`):
`kansli@strandvikens-vk.test`, Idrottsvägen 4, 451 50 Strandviken, the
synthetic organisation number 802000-0009 and two phone numbers ("Kansli",
"Kiosken i sporthallen"). Henrik sees Viktor's place in F2017's queue
(number 2) on his start page.

### Groups

| Club | Group (kind) | Owners | Admission | Members |
|---|---|---|---|---|
| SVK | Minivolley (training group, ages 7–8) | Sara | `direct` | 6 generated; Elsa played here until half a year ago |
| SVK | F2017 (team, girls ~9 yrs), capacity 10 | Erik, Sara | `waitlist`, **full**, shown in the club search: 5 waiting incl. Viktor (#2), one **offer outstanding** (expires in 3 days), one admitted out of order with a reason (sibling, priority reason `sibling`), one offer expired yesterday | Elsa, Maja, Alva, + 7 generated |
| SVK | Herr senior (team) | Johan | `direct` | Johan, Lars, + 4 generated (one with **club-level protected identity** set by Anna) |
| IKN | Fotboll (section) | Karin | — | parent of P2012 |
| IKN | P2012 (team, boys ~14 yrs) | Ahmed, **Peter** (co-owner appointed by Ahmed: IKN lets owners appoint co-owners, P1.10a) | `direct` | Oskar, Liam, + 6 generated |
| IKN | Innebandy (section) | — | — | parent of F2015 |
| IKN | F2015 (training group, girls ~11 yrs) | **none** (managers act) | `waitlist`, not full, **auto-offers on**, 1 waiting (the `waitlists:offers` job offers it a place within five minutes) | Maja, Nadia, + 5 generated |
| IKN | Styrelsen (board) | Karin | `closed` | board members |
| FIL | J2014 (team, girls ~12 yrs) | Lars | `direct` | Ingrid, + 5 generated (Sofie has applied); a veteran added by Lars as **team manager** (P1.10a) |
| FIL | Veteran (team, adults) | Lars | `direct` | Lars, + 4 generated |
| SVK | Damer B (team), **archived** | Sara | `direct` | none: archived with Johan (head coach) and Sara (player) in it, so their memberships ended (P1.10a) |

Group administration (P1.10a): SVK keeps `owners_can_appoint_co_owners`
off (Erik, F2017's owner, cannot appoint owners), IKN turns it on. SVK has
the season of this year (August to July) with F2017's 10 places set per
season, so the group page shows "10 of 10 places".

## Demo scenario: named personas

All names fictional. Children without own login have **no email**. Generated extras fill groups up to realistic sizes so each
club has roughly 10 named/central users plus generated players.

| # | Person | Age | Has login | Relationships (what it tests) |
|---|---|---|---|---|
| 1 | **Anna Lindqvist** | 41 | yes | SVK: **chair** (board) + **club manager** + **registrar** (does the register's work herself, P1.15 A2). Parent of Elsa (SVK) and Oskar (IKN) → board role + parent in two clubs |
| 2 | **Mikael Lindqvist** | 43 | yes | Parent of Elsa and Oskar; separate household from Anna (divorced) → two full guardians, separate addresses |
| 3 | **Elsa Lindqvist** | 9 | **no** | SVK F2017 player → child without account, managed by guardians |
| 4 | **Oskar Lindqvist** | 14 | yes | IKN P2012 player → teen with own login *and* guardians; was created by Anna as a child without email and **got his own email/login last year** (visible in history) |
| 5 | **Erik Johansson** | 38 | yes | SVK F2017 **head coach**; IKN floorball F2015 **assistant coach**; parent of Maja → leader in two clubs + parent; background check **valid** |
| 6 | **Maja Johansson** | 10 | no | Plays in SVK F2017 *and* IKN F2015 → one child in two clubs/sports |
| 7 | **Sara Ahmed** | 35 | yes | SVK **club manager** + **treasurer** + F2017 **team manager** (cash desk) + parent of Alva → several roles in one club, second manager; MFA required. Not the registrar: since P1.15 A2 she administers SVK but does not see the register's details, guardians or consents (the roles page offers her the registrar role) |
| 8 | **Alva Ahmed** | 9 | no | SVK F2017 player; **no photo consent** → tests consent filtering |
| 9 | **Gunilla Berg** | 68 | yes | Grandmother of Alva, **relative** with view-only rights → restricted guardian kind |
| 10 | **Johan Nilsson** | 27 | yes | SVK **registrar** (the full member register without manager rights, P1.2), Herr senior player and F2017 **assistant coach**; background check **expires in 20 days** → reminder flow |
| 11 | **Lars Haugen** | 45 | yes | Norwegian. FIL **club manager** + **registrar** (created the club via self sign-up) + **board member** + J2014 **head coach**; also **member/player in SVK Herr senior**, where he holds SVK's own group role **Materialansvarig** (P1.15 A2) (membership **paused**, P1.2) and IKN supporting member → person in all three clubs, nb-NO locale preference, background check (politiattest) valid in NO, **missing** in SE |
| 12 | **Ingrid Haugen** | 12 | no | Daughter of Lars, FIL J2014 player |
| 13 | **Karin Ek** | 52 | yes | IKN **club manager** + **registrar** + **safeguarding officer**; employed part-time as club administrator (staff, time reporting) |
| 14 | **Ahmed Yilmaz** | 47 | yes | IKN P2012 **head coach**; background check **expired** → must be flagged |
| 15 | **Liam Yilmaz** | 14 | yes | IKN P2012 player; user preference `en` locale → locale override |
| 16 | **Peter Sund** | 60 | yes | IKN **treasurer**; former SVK board member and **manager**, handed over to Anna last year → historic roles (valid_to in past); has a **pending manager hand-over** from Karin in IKN |
| 17 | **Nora Lund** | 30 | invited | SVK new leader, **invitation pending** (not yet accepted) |
| 18 | **Sofie Dahl** | 12 | no | Applied to FIL (J2014 preferred) through her mother: a **pending join request** (P1.1: no membership until approved) |
| 19 | **Ola Former** | 34 | yes | Left SVK 25 months ago: the first `privacy:retention` run purges his SVK profile (contact details, notes, consents); his account stays |
| 20 | **Platform Operator** | — | yes | Operator account with **no** club access; one time-limited support grant to IKN |
| 21 | **Emma Svensson** | 29 | yes | **Signed up without invitation, no club yet** → onboarding screen (find club / create club) |
| 22 | **Henrik Malm** | 36 | yes | Self-signed-up, added his son **Viktor Malm** (8, no login, no email) via "Add child"; Viktor is **#2 on SVK F2017's waiting list**, which also created a pending club join request |
| 23 | **Samira Karimi** | 39 | yes | Guardian of Nadia; **protected identity** (global, self-set); sees in Nadia's **access log** who opened her profile (P1.12); accepted IKN F2015's "Föräldrar" chat (P2.1) |
| 24 | **Nadia Karimi** | 11 | no | IKN F2015; **protected identity** set by Samira → invisible to other members, crossed-camera icon for leaders/managers, not in chats, no photo/stream tagging; her **access log** shows Erik twice last week and Karin yesterday |
| 25 | **Jonas Karimi** | 41 | yes | Second guardian of Nadia, **invited** as guardian by Samira (pending), prompted to enable protection |
| 26 | **Camilla Dahl** | 40 | yes | Mother of Sofie; applied for her in FIL (join request with J2014 as preferred group) |
| 27 | **Viktor Malm** | 8 | no | Son of Henrik (see 22): #2 on SVK F2017's waiting list, pending join request |
| 28 | **Vera Ahmed** | 13 | no | Alva's sister, no club: Sara can **give her her own login** (P1.3) |
| 29 | **Elsa Lindqvist** (duplicate) | 9 | no | Elsa added again by Mikael (same birth date, no clubs), Anna invited as second parent → **merge notice** for Anna and Mikael, merge and undo |
| 30 | **Nils Granqvist** | — | no | Alva's neighbour who drives to training: **contact person without login**, linked by Sara (schedule and messages) |
| 31 | **Bo Stöd** | — | no | Emma's **LSS contact person**, linked by Emma herself |
| 32 | **Tilde Yilmaz** | 18 | yes | IKN, own login; just reached the adult age (guardianships flagged) → **adult decision** page for Ahmed and Leyla |
| 33 | **Leyla Yilmaz** | 45 | yes | Tilde's mother, invited by Ahmed as second guardian |
| 34 | **Petra Johansson** | — | no | Recorded by Johan (SVK registrar) as Maja's mother **from a paper application**; ended by Anna (club manager) **with a reason** (history) |
| 35 | **Mats Berg** | 48 | yes | SVK **club manager**, the third administrator: with three, two can suspend the third without outside help (P1.15 A3) |
| 36 | **Linnea Holm** | 33 | yes | Was an SVK club manager; **suspended** last week by Anna and Sara (suspected break-in, demoted to an ordinary member) → a confirmed suspension on the administrators page and in the audit log |
| 37 | **Göran Lund** | 58 | yes | IKN **club manager** next to Karin (the minimum of two) |
| 38 | **Kari Haugen** | 44 | yes | Norwegian (nb). FIL **club manager** next to Lars: FIL has exactly two administrators |
| 39 | **Ulf Ek** | 63 | yes | Founded **Lövsta Bordtennisklubb** and is its only administrator: the grace period's banner and reminders |
| 40 | **Britt Sjöberg** | 58 | yes | Founded **Ekuddens Schackklubb**, of the club type Schackklubb: its roles came from the type's template (P1.15 B) |
| 41 | **Aron Nyström** | 36 | yes | Ekudden SK's second administrator next to Britt |

Ahmed is Liam's parent; Liam, like Oskar, was created as a child and got his
own login (half a year ago). The waiting list of F2017 has five waiting, one
outstanding offer (expires in 3 days), one admitted out of order ("sibling
already plays in the group") and one offer that a system job expired
yesterday. Henrik sees "Number 2 of 5" for Viktor on `/me/waitlists`; Erik
(owner) sees the list in order with the offer out on the group's waiting
list page; Sara (club manager) sees the out-of-turn admission with its
reason on the club's waiting lists page (P1.10b). Seeded now as data only, for modules that come later: background
checks (clearances), billing plans, chat rooms and the anonymisation
schedule (Ola left two years ago).

## Demo scenario: activity and other data (added as modules land)

- **Activities** (P1.4, `apps/api/src/seed/steps/activities.ts`, through the
  activities service): locations Strandvikens sporthall and the school's gym
  (SVK), Norrbacka IP and Norrbackahallen (IKN), Fjordvik kunstgress (FIL);
  "Strandviksskolans gymnastiksal" added by Erik, a leader (P1.6b): Erik may
  change it, Johan may use but not change it, Anna (club manager) changes
  any place.
  Weekly training series from ten weeks ago to six weeks ahead, public
  holidays skipped: SVK F2017 on Tuesdays 17:30 and Thursdays 18:00, **until
  further notice** (P1.14: sessions 13 months ahead, the group asked to
  answer three days before each session at 18:00, the coming Christmas break
  21 December – 6 January removed as a range, so Anna or Erik can bring a
  date back on the series page; the autumn-break week four weeks ago
  skipped; next week's Tuesday cancelled,
  "Hallen är upptagen av kommunen"; that Thursday moved to the school's gym,
  a detached session), SVK Herr senior on Mondays and Wednesdays at 20:00,
  split two weeks ahead into a winter schedule at 20:30, IKN P2012 (Mondays
  and Wednesdays; and "Fotbollsskola" the first Saturday of every month at
  10:00, for six months, P1.14), IKN F2015 (Tuesdays), FIL J2014 (Tuesdays and Thursdays,
  Norwegian holidays). Three matches per team (two weeks ago, in five days,
  in three weeks; away matches with a meeting place), a parents' meeting in
  F2017 and a joint training of IKN P2012 and F2015 next Saturday. Erik
  (coach in SVK and IKN, Maja's father) sees both clubs in "My schedule";
  Gunilla (Alva's grandmother, `view_schedule`) sees F2017; Bo (Emma's
  contact person) has only `receive_messages`, so no schedule.
- **Responses and attendance** (P1.5, `apps/api/src/seed/steps/attendance.ts`,
  through the attendance service): answers for the coming two weeks in SVK
  F2017 (Sara for Alva, Erik for Maja, about half of the generated players),
  Elsa's answer to the first match given by Anna and changed by Mikael to
  "not coming" with a note, Erik for Maja and Samira for Nadia in IKN F2015
  (Nadia counted, never named for other parents), and Oskar's and Liam's own
  answers to IKN P2012's match in five days (answers requested by the day
  before). Karin has called up a squad for that match (ADR 0036): Oskar and
  half the generated players; Liam is not called up, so his "not coming" is
  kept but not counted and the match is not in his schedule. Gunilla and Nils see Alva's schedule without answer buttons (no
  `sign_up`). Attendance for every past session of the youth teams (SVK
  F2017, IKN P2012 and F2015, FIL J2014), taken by their leaders on the day:
  most present, some absent or excused, the leaders present, a Minivolley
  player as a guest in F2017, one F2017 session cut short at 40 minutes and
  one with two participants (LOK-stöd hints), and Sara's correction of
  Alva's mark about 40 days ago ("Fel markering", after the lock; in
  history). An extra F2017 session ("Extrapass inför matchen") starts half
  an hour before seeding, so attendance can be taken at once (Maestro flow
  09). Generated players are in their groups since last year, so past
  sessions have them on the roster.
- **Events** (P1.6, ADR 0038, `apps/api/src/seed/steps/events.ts`, through
  the events service): Erik's "Höstcupen i Strandviken" for SVK F2017 in 12
  days (six places, offers on the waiting list with 24 hours to answer, sign
  up by day 8, 150 kr as a price text), with a form (T-shirt size, required;
  allergies or medication, sensitive; "can an adult drive") and two matches
  and a lunch (an "other" session labelled "Lunch", P1.6b) created with it, called up to the confirmed players. Sara signed up Alva
  (her allergy is sealed: only Sara and the organisers see it), Erik Maja,
  generated players themselves, and Anna Elsa last (on the waiting list).
  A player cancelled 30 hours ago, so the first in the queue got an offer
  that ran out six hours ago: the API's `events:expire_offers` job expires
  it on its first run and offers the place to the next. Karin's
  "Avslutningsfest" for all of IKN in 20 days (80 places, moving up
  automatically; food preferences and number of adults), with Samira's
  sign-up of Nadia. A car pool for the cup comes with a later prompt.
- **Chat** (P2.1, ADR 0047, `apps/api/src/seed/steps/chat.ts`, written through
  the chat service as the personas): every group's default channel (everyone
  in the group; where a leader is with children, the children's parents are
  added automatically). In SVK F2017's channel Erik moves Thursday's
  training (and edits the time), Anna answers him (a reply), Sara and Johan
  react, Sara reminds about the kiosk. Erik's closed **"Ledare"** channel
  with Johan and Sara. **"Tjejerna"**: Maja's closed children's chat with
  Elsa and Alva, which Anna joined as a parent (shown to the children).
  Johan's **direct message to Alva**: her mother Sara was added by the
  guardian rule. In IKN F2015 Erik's closed **"Föräldrar"** channel was
  offered to Samira (protected identity), who accepted it; Nadia is in no
  chat she has not accepted.
- SVK training plan "Volleyboll 9 år — hösttermin" shared publicly; IKN copies it.
- Club documents: statutes (stadgar), last annual meeting minutes, a board
  meeting with agenda.
- Team cash desk for SVK F2017 with a cup income and two expenses.
- Two sponsor banners for SVK.
- **Notifications** (P1.7, ADR 0039, `apps/api/src/seed/steps/notifications.ts`):
  the seed has no worker, so it writes the inboxes directly (system
  context) with the params the worker would store, and marks its own domain
  events as handled by the worker's `notifications` handler (they are
  history, not news: starting the worker sends nothing for them). Anna:
  next week's cancelled F2017 Tuesday (about Elsa) and Oskar's call-up for
  an IKN P2012 session, both unread, and an answer reminder for F2017
  (read), plus a phone with push (fake provider, when
  `NOTIFICATION_TOKEN_KEY` is set). Mikael: the same cancellation; email
  "never" for the schedule and quiet hours 22:00–06:30. Erik: a late "not
  coming" for Elsa. Liam: no longer called up (English). Lars: a moved FIL
  session (Norwegian). Gunilla: her join request decided. Nils and Bo get
  nothing (no account). The load scenario has five notices per child to its
  parent over the last 90 days (about 600,000 at full size, adding about
  a minute), the latest unread, with push and daily-email deliveries for
  the last 30 days.
- **Privacy** (P1.8a, ADR 0041, `apps/api/src/seed/steps/privacy.ts`, before
  the notifications step so its events are not news): SVK's board decided
  the former-member period (24 months) and the consents asked (photo, video,
  contact details to the team and to the club) three months ago (§ 7), so
  SVK's privacy policy is version 2; IKN's board asked for photo, streaming
  and marketing a year ago (§ 12); FIL uses the defaults ("not yet
  decided"). SVK published its own photo text a year ago and a new version
  last month: Anna's consent for Elsa was given for the first, so she sees
  "the club has a new text". Anna shows her phone to Elsa's team
  (`contacts_group`), Mikael does not. Oskar (14) gave his own photo consent
  in IKN and withdrew streaming. Johan recorded a paper consent for an F2017
  player ("Pappersblankett augusti"). Nadia's photo consents are "not
  applicable" (protected). A Herr senior player left SVK last week and
  chose "remove my contact details now" (the worker purges them). Two people
  without a login and without any club are orphaned: one 40 months ago
  (erased by the first `privacy:retention` run), one 6 months ago. Erik's
  leave preview lists his head-coach function in F2017 to step down from.
  P1.8b: Anna requested "download my data" for herself and for Elsa ten
  days ago (the files have expired; the requests stay listed). A
  generated SVK Herr player scheduled their account deletion three days
  ago (the grace period runs); another deleted their account a month ago
  (left SVK, anonymised, in the deletion ledger). Ahmed's deletion preview
  names his ownership of IKN P2012 as the blocker. Mikael has no blockers:
  the web and Maestro tests schedule his deletion and cancel it.
- **Billing** (only with `BILLING_ENABLED=true`, P0.12, P1.13): plans Free,
  Standard (499 SEK per month, 4,990 per year) and the Streaming add-on
  (199 SEK), all prices excluding VAT; the fictional demo seller
  (`DEMO_SELLER`). SVK on Standard with Streaming (active) with billing
  details (Strandvikens Volleybollklubb, `kassor@strandviken.example`,
  reference "Kassören"; no organisation number seeded) and invoices issued
  85, 55 and 25 days ago for the last three months: the first paid on time,
  the second charged Streaming twice (a credit note for the duplicate line)
  and was paid three days late after a reminder, the current one is open
  and due in five days. Anna and Sara see the billing page; Johan
  (registrar) gets 403. IKN on Free (active), no invoices: Peter (treasurer)
  can enter details, Karin can choose Standard. FIL in a Standard trial
  ending in ten days: Lars sees the trial banner. The operator sees all
  three in `/ops/billing`. With `--scenario load` every load club gets a year
  of paid monthly invoices. With billing off the demo has no billing data
  (`apps/api/src/seed/steps/billing.ts`).
- **Protected identity and the profile view log** (P1.12,
  `apps/api/src/seed/steps/protection.ts`): Samira's and Nadia's global flags
  are set by Samira through the service (set by Samira). In IKN, Erik (F2015
  assistant coach) opened Nadia's profile twice last week and Karin
  (manager) once yesterday; Karin opened Samira's once: Samira sees them in
  Nadia's access log, Karin in IKN's log. SVK logs every profile view (set
  by Anna): Johan (registrar) opened Elsa's and Alva's profiles last week,
  so Anna and Sara see it in their children's logs; Johan and Sara each
  opened the generated SVK Herr senior player who is protected in the club
  (set by Anna). Ola, who left SVK, opened Elsa's profile before leaving and
  appears only as "a former member" (an anonymisation ledger entry). Anna set
  and removed club protection on Lars last year (two history rows and audit
  events; Lars is not protected now). The load scenario has no extra views.
- **Calendar feeds** (P1.11, `apps/api/src/seed/steps/calendar.ts`): Anna
  has a "My schedule" feed for Elsa and Oskar
  (`/cal/demo-anna-my-schedule.ics`), Erik subscribes to the F2017 group
  feed (`/cal/demo-erik-f2017.ics`), Ahmed has an open feed and one he
  revoked a month ago. The demo secrets are fixed so the request budgets
  can fetch them; real secrets are random. The seed prints the feed URLs
  and, when `CALENDAR_TOKEN_KEY` is set, an answer link for Elsa's next
  F2017 training, so answering from a calendar can be tried without a
  phone. The rows are written directly as the persona (the service would
  make random secrets).
- **Record history:** the seed writes through the same services as the app,
  with the persona as actor, so history exists from the start. It also replays a
  few changes over time so the History panel has content: Anna moved Elsa
  between groups (Minivolley → F2017, half a year ago), Erik updated his own
  phone number (two months ago), Anna accepted Peter's hand-over (last year,
  which ended his manager role; his board role ended then too), Anna approved
  Johan's application (last year), Oskar and Liam got their own logins, and a
  system job expired an offer on F2017's waiting list (yesterday). Sara
  corrected an attendance mark (P1.5, above). For the history views (P1.9):
  Sara changed F2017's places from 12 to 10 five months ago, Johan changed
  Elsa's membership type to family last month, and Erik moved the away match
  (against Älvdalens VBK) 30 minutes later. The panels then show these with
  the person acting; the erased Herr player (P1.8b) shows as "Deleted user".
- **History volume** (P1.9, `pnpm db:seed --history-volume` on top of the
  load scenario; Nightly and by hand only): two years of record history
  (about 5 million rows) and audit events (about 500,000) for Storklubben,
  with monthly partitions as in production, and five years of changes on its
  member number 1 (the person panel's worst case). Used by
  `pnpm --filter @clubadmin/api test:volume`.
- **Member register** (P1.2): Johan is SVK's registrar, Lars's SVK membership
  is paused and Ola's ended; Elsa and Maja gave photo consent, the others in
  F2017 (Alva among them) did not. Sara exported SVK's register three days
  ago (name, member number, membership type, groups); the record is in the
  exports list, its file expired. Peter (IKN treasurer) sees IKN's limited
  board list, never Nadia.
- **Member imports** (P1.3b, `apps/api/src/seed/steps/imports.ts`): Lars
  imported four members into FIL (Sindre and Mia Bakke, siblings with one
  parent, Tobias Strand, and Per Nygård in Veteran); the import is done and
  its report shows the counts. Karin's import of the sample file
  `docs/demodata/imports/medlemmar.csv` (Swedish headers, `;`, Windows-1252:
  six members, Saga Öberg with four guardians, two parents, a step-parent
  and a grandmother; Ines' email goes to her father) is in review in IKN,
  with two extra rows: Oskar Lindkvist, a possible duplicate of Oskar
  Lindqvist, and Tove Ek without a birth date (an error). Open
  `/clubs/<ikn>/members/import` as Karin with a second factor to try the
  preview. Both start from a file through the import service.

## Club-defined roles (P1.15)

Every club has the built-in template's roles (ADR 0046). SVK calls its team
managers **Lagansvarig** and has its own group role **Materialansvarig**
("Planera gruppens aktiviteter"), held by Lars in Herr; FIL's team managers
(**Lagledare**) no longer see consents. The administrators doing the register's
work themselves (Anna in SVK, Karin in IKN, Lars in FIL) also hold the registrar role; Sara
(SVK) does not, which shows the club manager's split: try the roles page
(`/clubs/<svk>/roles`) as Sara, and "Mina roller" (`/me/roles`) as anyone.

## Club types (P1.15 B)

The built-in type **Idrottsförening** (`sports_club`) is today's template:
SVK, IKN, FIL and Lövsta BTK have it. The operator adds the type
**Schackklubb** (`chess_club`): Föreningsansvarig and Ordförande (the locked
roles), "Spelare" (the participant role `member`), "Tränare" (`head_coach`)
and its own "Turneringsledare" (`tournament_director`, names in sv, en and
nb). **Ekuddens Schackklubb** (Britt, Aron) has that type: its roles page
shows the template to compare and copy from, and has no registrar. Try
`/ops/club-types` as the operator (with a second factor) and creating a
club, which asks for the type.

## At least two administrators (P1.15 A3)

SVK has three administrators (Anna, Sara, Mats) and the confirmed
suspension of Linnea (requested by Anna, confirmed by Sara, a suspected
break-in, demoted); IKN (Karin, Göran) and FIL (Lars, Kari) have two, and
see the recommendation of a third; **Lövsta BTK** has only Ulf and 12 days
of its grace period left. Try `/clubs/<svk>/administrators` as Sara, start
a suspension of Mats (with a second factor) and confirm it as Anna; log in
as Ulf to see the deadline. The minimal scenario has two administrators
(the manager and the member). The load scenario's clubs have a grace
period (their managers have no login).

## Load scenario

1,000 clubs, ~200,000 people (per club 120 children with a parent each, 40
adult members, 40 parents who are not members, 8 teams with two leaders, a
club manager), `--size` sets the number of clubs, plus **Storklubben**: one
club of 10,000 members in 40 teams (half with photo consent, every 50th
membership paused, a few protected) for the member register's budgets
(P1.2). Activities (P1.4): 32 trainings per team, eight weeks back and
eight ahead (256,000 activities with their calendar entries). Responses and
attendance (P1.5): marks for each team's six latest past sessions (members
and leaders, about 0.8 million) and answers from half of the children to the
next four. More
years of activities are added by their modules. Chat (P2.1): every load
group's default channel with its members and 60 messages. Used by
the performance tests (`performance.md`).
