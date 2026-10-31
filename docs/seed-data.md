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
- **Rows written directly** (waiting lists, join requests, club invitations,
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
| **Strandvikens Volleybollklubb** (SVK) | SE / sv-SE / Europe/Stockholm | Volleyball | `approval` | Anna, Sara (two managers); Peter was manager until last year | Paid plan, active |
| **IK Norrbacka** (IKN) | SE / sv-SE / Europe/Stockholm | Multi-sport: football + floorball sections | `open` | Karin; hand-over to Peter **pending** his acceptance | Free plan |
| **Fjordvik Idrettslag** (FIL) | NO / nb-NO / Europe/Oslo | Handball | `invite_only` | Lars (sole manager → "last manager cannot leave" rule) | Trial, ends in 10 days |

SVK has contact details (P1.6b, `contact` in `docs/demodata/clubs.json`):
`kansli@strandvikens-vk.test`, Idrottsvägen 4, 451 50 Strandviken, the
synthetic organisation number 802000-0009 and two phone numbers ("Kansli",
"Kiosken i sporthallen"). Henrik sees Viktor's place in F2017's queue
(number 2) on his start page.

### Groups

| Club | Group (kind) | Owners | Admission | Members |
|---|---|---|---|---|
| SVK | Minivolley (training group, ages 7–8) | Sara | `direct` | 6 generated; Elsa played here until half a year ago |
| SVK | F2017 (team, girls ~9 yrs), capacity 10 | Erik, Sara | `waitlist`, **full**: 5 waiting incl. Viktor (#2), one **offer outstanding** (expires in 3 days), one admitted out of order with a reason (sibling) | Elsa, Maja, Alva, + 7 generated |
| SVK | Herr senior (team) | Johan | `direct` | Johan, Lars, + 4 generated (one with **club-level protected identity** set by Anna) |
| IKN | Fotboll (section) | Karin | — | parent of P2012 |
| IKN | P2012 (team, boys ~14 yrs) | Ahmed | `direct` | Oskar, Liam, + 6 generated |
| IKN | Innebandy (section) | — | — | parent of F2015 |
| IKN | F2015 (training group, girls ~11 yrs) | **none** (managers act) | `waitlist`, not full, 1 waiting | Maja, Nadia, + 5 generated |
| IKN | Styrelsen (board) | Karin | `closed` | board members |
| FIL | J2014 (team, girls ~12 yrs) | Lars | `direct` | Ingrid, + 5 generated (Sofie has applied) |
| FIL | Veteran (team, adults) | Lars | `direct` | Lars, + 4 generated |

## Demo scenario: named personas

All names fictional. Children without own login have **no email**. Generated extras fill groups up to realistic sizes so each
club has roughly 10 named/central users plus generated players.

| # | Person | Age | Has login | Relationships (what it tests) |
|---|---|---|---|---|
| 1 | **Anna Lindqvist** | 41 | yes | SVK: **chair** (board) + **club manager**. Parent of Elsa (SVK) and Oskar (IKN) → board role + parent in two clubs |
| 2 | **Mikael Lindqvist** | 43 | yes | Parent of Elsa and Oskar; separate household from Anna (divorced) → two full guardians, separate addresses |
| 3 | **Elsa Lindqvist** | 9 | **no** | SVK F2017 player → child without account, managed by guardians |
| 4 | **Oskar Lindqvist** | 14 | yes | IKN P2012 player → teen with own login *and* guardians; was created by Anna as a child without email and **got his own email/login last year** (visible in history) |
| 5 | **Erik Johansson** | 38 | yes | SVK F2017 **head coach**; IKN floorball F2015 **assistant coach**; parent of Maja → leader in two clubs + parent; background check **valid** |
| 6 | **Maja Johansson** | 10 | no | Plays in SVK F2017 *and* IKN F2015 → one child in two clubs/sports |
| 7 | **Sara Ahmed** | 35 | yes | SVK **club manager** + **treasurer** + F2017 **team manager** (cash desk) + parent of Alva → several roles in one club, second manager; MFA required |
| 8 | **Alva Ahmed** | 9 | no | SVK F2017 player; **no photo consent** → tests consent filtering |
| 9 | **Gunilla Berg** | 68 | yes | Grandmother of Alva, **relative** with view-only rights → restricted guardian kind |
| 10 | **Johan Nilsson** | 27 | yes | SVK **registrar** (the full member register without manager rights, P1.2), Herr senior player and F2017 **assistant coach**; background check **expires in 20 days** → reminder flow |
| 11 | **Lars Haugen** | 45 | yes | Norwegian. FIL **club manager** (created the club via self sign-up) + **board member** + J2014 **head coach**; also **member/player in SVK Herr senior** (membership **paused**, P1.2) and IKN supporting member → person in all three clubs, nb-NO locale preference, background check (politiattest) valid in NO, **missing** in SE |
| 12 | **Ingrid Haugen** | 12 | no | Daughter of Lars, FIL J2014 player |
| 13 | **Karin Ek** | 52 | yes | IKN **club manager** + **safeguarding officer**; employed part-time as club administrator (staff, time reporting) |
| 14 | **Ahmed Yilmaz** | 47 | yes | IKN P2012 **head coach**; background check **expired** → must be flagged |
| 15 | **Liam Yilmaz** | 14 | yes | IKN P2012 player; user preference `en` locale → locale override |
| 16 | **Peter Sund** | 60 | yes | IKN **treasurer**; former SVK board member and **manager**, handed over to Anna last year → historic roles (valid_to in past); has a **pending manager hand-over** from Karin in IKN |
| 17 | **Nora Lund** | 30 | invited | SVK new leader, **invitation pending** (not yet accepted) |
| 18 | **Sofie Dahl** | 12 | no | Applied to FIL (J2014 preferred) through her mother: a **pending join request** (P1.1: no membership until approved) |
| 19 | **Ola Former** | 34 | yes | Left SVK 2 years ago, scheduled for **anonymisation** → retention job |
| 20 | **Platform Operator** | — | yes | Operator account with **no** club access; one time-limited support grant to IKN |
| 21 | **Emma Svensson** | 29 | yes | **Signed up without invitation, no club yet** → onboarding screen (find club / create club) |
| 22 | **Henrik Malm** | 36 | yes | Self-signed-up, added his son **Viktor Malm** (8, no login, no email) via "Add child"; Viktor is **#2 on SVK F2017's waiting list**, which also created a pending club join request |
| 23 | **Samira Karimi** | 39 | yes | Guardian of Nadia; **protected identity** (global, self-set); accepted the IKN F2015 "Föräldrar" chat room only |
| 24 | **Nadia Karimi** | 11 | no | IKN F2015; **protected identity** set by Samira → invisible to other members, crossed-camera icon for leaders/managers, not in chats, no photo/stream tagging |
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

Ahmed is Liam's parent; Liam, like Oskar, was created as a child and got his
own login (half a year ago). The waiting list of F2017 has five waiting, one
outstanding offer (expires in 3 days), one admitted out of order ("sibling
already plays in the group") and one offer that a system job expired
yesterday. Seeded now as data only, for modules that come later: background
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
  holidays skipped: SVK F2017 on Tuesdays 17:30 and Thursdays 18:00 (the
  autumn-break week four weeks ago skipped; next week's Tuesday cancelled,
  "Hallen är upptagen av kommunen"; that Thursday moved to the school's gym,
  a detached session), SVK Herr senior on Mondays and Wednesdays at 20:00,
  split two weeks ahead into a winter schedule at 20:30, IKN P2012 (Mondays
  and Wednesdays), IKN F2015 (Tuesdays), FIL J2014 (Tuesdays and Thursdays,
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
- Chat rooms per group: "Ledare", "Föräldrar", "Spelare" (players room only for
  groups where players have accounts); protected persons only where accepted.
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
- **Billing** (only with `BILLING_ENABLED=true`, P0.12): plans Free, Standard
  and the Streaming add-on; SVK on Standard with Streaming (active), IKN on
  Free (active), FIL in a Standard trial ending in ten days. With billing off
  the demo has no billing data (`apps/api/src/seed/steps/billing.ts`).
- Calendar feeds: Anna has a "my schedule" feed including Elsa and Oskar;
  Erik subscribes to the F2017 group feed; Ahmed has revoked an old feed token.
- **Record history:** the seed writes through the same services as the app,
  with the persona as actor, so history exists from the start. It also replays a
  few changes over time so the History panel has content: Anna moved Elsa
  between groups (Minivolley → F2017, half a year ago), Erik updated his own
  phone number (two months ago), Anna accepted Peter's hand-over (last year,
  which ended his manager role; his board role ended then too), Anna approved
  Johan's application (last year), Oskar and Liam got their own logins, and a
  system job expired an offer on F2017's waiting list (yesterday). Sara
  corrected an attendance mark (P1.5, above).
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
years of activities, and chat messages (10 million), are added by their
modules. Used by
the performance tests (`performance.md`).
