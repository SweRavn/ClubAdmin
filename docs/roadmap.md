# Roadmap

Each work package becomes a prompt in `docs/prompts/` and a GitHub issue, and
is delivered as one or a few PRs.

## Phase 0 — Foundation

Ordered so each package only depends on earlier ones. Prompts:
[`prompts/`](prompts/).

| ID | Work package | Depends on |
|---|---|---|
| P0.1 | Monorepo scaffolding: pnpm, Turborepo, TS/lint/format config, CI, licence check, DCO and SPDX checks | — |
| P0.2 | Local environment: docker compose (Postgres, Valkey, Zitadel, Garage, Caddy, Mailpit), `pnpm dev` | P0.1 |
| P0.3 | API and worker skeletons: NestJS/Fastify, config, health, OpenAPI from Zod, problem details, logging with redaction, OpenTelemetry, generated API client | P0.2 |
| P0.4 | Database foundation: Drizzle, migrations, DB roles, `withTenant`/`withActor`, RLS helpers, record history (ADR 0017), audit events, outbox, test harness | P0.3 |
| P0.5 | Core domain schema and services: people, accounts, clubs, groups, owners, memberships, roles, guardianships, profiles, protected-identity flags, invariants | P0.4 |
| P0.6 | Authentication: Zitadel config as code, API token validation, account provisioning, web BFF session, `DEV_AUTH` | P0.5 |
| P0.7 | Authorization engine, `PersonVisibility`, first read endpoints | P0.6 |
| P0.8 | Seed framework and demo scenario (`seed-data.md`) | P0.7 |
| P0.9 | Web shell: layout, club switcher, i18n, persona login, group pages, "Source code" link | P0.8 |
| P0.10 | Mobile shell: Expo app, PKCE login, club switcher, i18n, persisted cache; per-account rate limits | P0.9 |
| P0.11 | Backup and restore: pgBackRest, object replication, `ops:verify-backup`, runbooks | P0.4 |
| P0.12 | Entitlements service and optional billing module skeleton | P0.7 |

## Phase 1 — MVP

| ID | Work package |
|---|---|
| P1.1 | Self sign-up, club creation, club managers (multiple, hand-over), join policies and requests, invitations (ADR 0018) |
| P1.2 | Member register UI (search, filter, export) with field-level permissions |
| P1.3 | Guardian/child management: "Add child" without email, invite co-guardian, merge duplicates, "give own login" with the child's own email, relative access, age transitions |
| P1.3b | Adding members by hand and importing them from CSV/Excel (columns mapped, preview, duplicates within the club, any number of guardians per child; `step_parent` and `foster_parent` kinds) |
| P1.4 | Activities: recurring trainings, matches, locations, in-app calendar |
| P1.5 | Responses (attending / not attending) and attendance taking |
| P1.6 | Events with sign-up forms, deadlines, capacity, waiting lists |
| P1.6b | Clean-up after hands-on testing: events with only name and start, any number of sessions and questions, given-name order, creating/editing/deleting groups, leaders' places and answers, club settings and contact details, queue status, joining with a code, `pnpm dev:idp-sync` |
| P1.7 | Notifications: an inbox on web and in the app, push (Expo), one daily email at 17:00 with urgent notices at once, settings per category, quiet hours, one-click unsubscribe (ADR 0039) |
| P1.8a | Privacy I: consents (incl. contact visibility), leave club, the club's privacy policy decided by the board, retention jobs |
| P1.8b | Privacy II: "download my data", account deletion, ward erasure |
| P1.9 | Audit log and record-history UI ("History" panel on detail pages) |
| P1.10 | Groups admin: group owners, group hierarchy, waiting lists with offers and admission (ADR 0019); split into P1.10a (owners, seasons, members, archiving) and P1.10b (waiting lists) |
| P1.11 | Calendar subscriptions: secret iCal feeds (my schedule / group / club) with one-click answer links (ADR 0021) |
| P1.12 | Protected identity UI: flags, crossed-camera icon, chat-acceptance flow, access log (ADR 0022) |
| P1.13 | Billing: plans, subscriptions, invoices (only active with `BILLING_ENABLED`) |
| P1.14 | Review fixes and clean-up before Phase 2 (first: recurring trainings with calendar-like rules, open-ended series and a timed answer request) |
| P1.15 | Club-defined roles and permissions (roles per club built from a catalogue of permissions, immediate effect, pedagogical role editor); club types with role templates maintained by operators |

## Phase 2 — Communication and compliance

Chat is a unique selling point and comes first. The decisions of
2026-11-12 are in the ADRs and the prompts; this table is the overview.

| ID | Work package | Decisions |
|---|---|---|
| [P2.1](prompts/P2.1-chat.md) | Chat: channels per group, open or closed, real time, "Mina kanaler", push per channel, child safety | ADR 0016, ADR 0047, `dpia-chat.md` |
| [P2.2](prompts/P2.2-file-archive.md) | Documents I: file archive, audiences, documents attached to notices | ADR 0049 |
| [P2.3](prompts/P2.3-announcements.md) | Announcements: the board in the app, email and push in one message | ADR 0039, ADR 0049 (audiences) |
| [P2.4](prompts/P2.4-governing-documents-and-meetings.md) | Documents II and meetings: governing documents, agendas, minutes, signing in the app | ADR 0037, ADR 0049 |
| [P2.5](prompts/P2.5-car-pooling-and-attestation.md) | Car pooling, mileage and a general attestation flow | ADR 0048 |
| [P2.6](prompts/P2.6-volunteer-duties.md) | Volunteer duties | ADR 0050 |
| [P2.7](prompts/P2.7-reporting-plugins.md) | Plugins for grant reporting and background checks; LOK and LAM | ADR 0051 |
| [P2.8](prompts/P2.8-background-check-plugins.md) | Background-check plugins for Sweden and Norway, tracking screens | ADR 0047, ADR 0051 |

Each prompt lists its new permissions with the template roles that get
them by default (P1.15 decision 5). The order and dependencies are in
[`prompts/README.md`](prompts/README.md). Later in chat: a reviewing bot
that alerts the safeguarding officers (ADR 0047).

## Phase 3 — Money and content

Team cash desk · member fees, invoicing, Swish/card payments · paying
attested expense claims (mileage from car pools first, ADR 0048) · buying
out volunteer duties (ADR 0050) · club budget ·
training plan library (versioning, sharing, copying, licences) · sponsors/ads ·
public club website pages · facility booking.

## Phase 4 — Heavy and specialised

**Tournaments and match reporting.** A club sets up a tournament (a cup or
a short series), built on events and their sign-up (ADR 0038):

- **Fields and slots:** the venue's fields or courts (places, ADR 0034;
  facility booking from Phase 3 when it exists) with the times they are
  free and the match length per class.
- **Teams:** the club's own groups and guest teams from other clubs
  (registered through the event's sign-up, contact person by email;
  ClubAdmin clubs can enter their own teams directly), sorted into classes
  (age, gender, level).
- **Format:** group stages and knockout rounds per class; seeding or a
  draw; a generated schedule over the fields and slots without clashes
  (no team twice at once, rest between matches), adjustable by hand.
- **Scoring:** rules per sport and class (points for a win, draw and loss,
  sets or periods, tie-breakers such as goal difference, goals scored and
  head-to-head; age classes where results are not shown, as federations
  require for younger children).
- **Results:** reported per match from the app by the match official or
  the team leaders (the other side confirms; the tournament's organisers
  correct), live standings and brackets in the app and on the club's
  public pages (Phase 3), notices to the teams' members when a schedule
  changes.
- **Match reports** for the club's own matches (activities of kind `match`,
  in tournaments or not): the result, who played, scorers and notes,
  feeding the team's statistics; names only through the PersonPresenter,
  players with protected identity never listed publicly (ADR 0022).
- Officials, referees and the score table are volunteer duties (ADR 0050).
  Needs an ADR and a prompt before it is built.

Calendar invitations by email with Accept/Decline from the native calendar
(iMIP, ADR 0021; lower priority, since the calendar feeds of P1.11 already
put the schedule in people's calendars with answer links) · automatic fair
distribution of volunteer duties by quota and unavailability, and a
register of people's qualifications (training, licences) for duties and
leaders (ADR 0050) · live streaming and recordings (a video broadcast
started from a chat channel, e.g. a match sent to everyone in a group,
including supporters such as a grandparent who is in the group to watch its
matches; recordings kept per the club's retention) · staff time reporting
and salary data with payroll export · bookkeeping integrations (SIE, Fortnox, Visma) · more country
packs · federation integrations · public API for third parties.
