# Seed data and development login

Without a pilot club, development and testing rely on a realistic, deterministic
demo dataset. It must be loadable with one command and exercise the hard
patterns of the domain model.

## Commands

```
pnpm db:seed                      # load the "demo" scenario into an empty database
pnpm db:reset                     # drop + migrate + seed demo (development only)
pnpm db:seed --scenario load      # large volume for performance tests
pnpm db:seed --scenario minimal   # one club, three people (fast unit/integration tests)
```

`pnpm dev` runs `db:reset` automatically on first start if the database is empty.

Open question before P0.8: where the seed runner lives, since it should use the
domain services in `apps/api` and packages cannot import apps ([#4](https://github.com/SweRavn/ClubAdmin/issues/4)).

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
- Each feature module adds its own seed step (`packages/db/seed/<module>.ts`)
  on top of the core personas, so the dataset grows with the application.

## Development login (`DEV_AUTH`)

With `DEV_AUTH=true` (only allowed when `NODE_ENV=development`), the web login
page shows a **persona picker**: a list of seeded people with their roles. One
click logs in as that person. No Zitadel needed for everyday development. A
banner shows "Development login — logged in as Anna Lindqvist". The API logs a
warning on startup and refuses to start with `DEV_AUTH=true` in production.

Optionally `pnpm dev:idp-sync` creates the same personas as users in the local
Zitadel (password `demo-password-123`, documented) to test the real login flow.

## Demo scenario: clubs

| Club | Country / locale / TZ | Sport(s) | Join policy | Managers | Billing (if enabled) |
|---|---|---|---|---|---|
| **Strandvikens Volleybollklubb** (SVK) | SE / sv-SE / Europe/Stockholm | Volleyball | `approval` | Anna, Sara (two managers); Peter was manager until last year | Paid plan, active |
| **IK Norrbacka** (IKN) | SE / sv-SE / Europe/Stockholm | Multi-sport: football + floorball sections | `open` | Karin; hand-over to Peter **pending** his acceptance | Free plan |
| **Fjordvik Idrettslag** (FIL) | NO / nb-NO / Europe/Oslo | Handball | `invite_only` | Lars (sole manager → "last manager cannot leave" rule) | Trial, ends in 10 days |

### Groups

| Club | Group (kind) | Owners | Admission | Members |
|---|---|---|---|---|
| SVK | F2017 (team, girls ~9 yrs), capacity 10 | Erik, Sara | `waitlist`, **full**: 5 waiting incl. Viktor (#2), one **offer outstanding** (expires in 3 days), one admitted out of order with a reason (sibling) | Elsa, Maja, Alva, + 7 generated |
| SVK | Herr senior (team) | Johan | `direct` | Johan, Lars, + 4 generated (one with **club-level protected identity** set by Anna) |
| IKN | Fotboll (section) | Karin | — | parent of P2012 |
| IKN | P2012 (team, boys ~14 yrs) | Ahmed | `direct` | Oskar, Liam, + 6 generated |
| IKN | Innebandy (section) | — | — | parent of F2015 |
| IKN | F2015 (training group, girls ~11 yrs) | **none** (managers act) | `waitlist`, not full, 1 waiting | Maja, Nadia, + 5 generated |
| IKN | Styrelsen (board) | Karin | `closed` | board members |
| FIL | J2014 (team, girls ~12 yrs) | Lars | `direct` | Ingrid, Sofie, + 5 generated |
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
| 10 | **Johan Nilsson** | 27 | yes | SVK Herr senior player and F2017 **assistant coach**; background check **expires in 20 days** → reminder flow |
| 11 | **Lars Haugen** | 45 | yes | Norwegian. FIL **club manager** (created the club via self sign-up) + **board member** + J2014 **head coach**; also **member/player in SVK Herr senior** and IKN supporting member → person in all three clubs, nb-NO locale preference, background check (politiattest) valid in NO, **missing** in SE |
| 12 | **Ingrid Haugen** | 12 | no | Daughter of Lars, FIL J2014 player |
| 13 | **Karin Ek** | 52 | yes | IKN **club manager** + **safeguarding officer**; employed part-time as club administrator (staff, time reporting) |
| 14 | **Ahmed Yilmaz** | 47 | yes | IKN P2012 **head coach**; background check **expired** → must be flagged |
| 15 | **Liam Yilmaz** | 14 | yes | IKN P2012 player; user preference `en` locale → locale override |
| 16 | **Peter Sund** | 60 | yes | IKN **treasurer**; former SVK board member and **manager**, handed over to Anna last year → historic roles (valid_to in past); has a **pending manager hand-over** from Karin in IKN |
| 17 | **Nora Lund** | 30 | invited | SVK new leader, **invitation pending** (not yet accepted) |
| 18 | **Sofie Dahl** | 12 | no | FIL J2014; membership **applied**, awaiting approval |
| 19 | **Ola Former** | 34 | yes | Left SVK 2 years ago, scheduled for **anonymisation** → retention job |
| 20 | **Platform Operator** | — | yes | Operator account with **no** club access; one time-limited support grant to IKN |
| 21 | **Emma Svensson** | 29 | yes | **Signed up without invitation, no club yet** → onboarding screen (find club / create club) |
| 22 | **Henrik Malm** | 36 | yes | Self-signed-up, added his son **Viktor Malm** (8, no login, no email) via "Add child"; Viktor is **#2 on SVK F2017's waiting list**, which also created a pending club join request |
| 23 | **Samira Karimi** | 39 | yes | Guardian of Nadia; **protected identity** (global, self-set); accepted the IKN F2015 "Föräldrar" chat room only |
| 24 | **Nadia Karimi** | 11 | no | IKN F2015; **protected identity** set by Samira → invisible to other members, crossed-camera icon for leaders/managers, not in chats, no photo/stream tagging |
| 25 | **Jonas Karimi** | 41 | yes | Second guardian of Nadia, **invited** as guardian by Samira (pending), prompted to enable protection |

## Demo scenario: activity and other data (added as modules land)

- Past 10 weeks of recurring trainings for every youth team with attendance
  (some sessions below LOK-stöd thresholds to test validation).
- Upcoming 6 weeks of trainings, 3 matches per team, one cup weekend (event with
  sign-up, deadline, and car pool: Mikael offers 3 seats, Anna requests 1).
- Chat rooms per group: "Ledare", "Föräldrar", "Spelare" (players room only for
  groups where players have accounts); protected persons only where accepted.
- SVK training plan "Volleyboll 9 år — hösttermin" shared publicly; IKN copies it.
- Club documents: statutes (stadgar), last annual meeting minutes, a board
  meeting with agenda.
- Team cash desk for SVK F2017 with a cup income and two expenses.
- Two sponsor banners for SVK.
- Calendar feeds: Anna has a "my schedule" feed including Elsa and Oskar;
  Erik subscribes to the F2017 group feed; Ahmed has revoked an old feed token.
- **Record history:** the seed writes through the same services as the app,
  with the persona as actor, so history exists from the start. It also replays a
  few changes over time so the History panel has content: Anna moved Elsa
  between groups, Erik updated his own phone number, Anna ended Peter's
  manager role, Sara corrected an attendance mark, Karin approved Sofie's
  earlier application, and one change made by a system job.

## Load scenario

1,000 clubs, ~200,000 people, 5 years of activities and attendance, 10 million
chat messages — generated with the same generators, used by performance tests
(`performance.md`).
