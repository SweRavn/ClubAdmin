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

**Chat is a unique selling point and comes first in this phase.** What it
must do (maintainer, 2026-11-12):

- **Built in-house (ADR 0016).** Postgres (messages partitioned by month),
  the API's WebSocket gateway with Valkey pub/sub between instances, and
  push; encrypted in transit and at rest, not end to end (moderation and
  safeguarding review must stay possible).
- **First revision:** text, reactions, replies and read receipts.
  - **Editing** a message (a typo) is supported; every edit is kept in the
    message's history (each version with its time), the message shows that
    it was edited, and those who may read the chat can see the earlier
    versions. Nothing an edit replaces is lost (ADR 0047).
  - **Files and images are prepared, not supported yet:** the data model,
    API shapes and storage (object storage, as for imports) leave room for
    attachments on a message, so adding uploads later needs no migration
    of existing messages; the first revision accepts text only.
- **Real time.** Messages arrive at once on web and in the app; the
  `authz.changed` event of P1.15 travels on the same connection. The app keeps working from its cache without a
  connection (cache first, ADR 0040) and sends queued messages when it is
  back online.
- **Channels in every group.** A group has its channels (a default channel
  for everyone in the group, more as needed). Whoever creates a channel
  chooses who is in it (people of the group, or a subset, e.g. the coaches
  or one team's parents); a permission in the role catalogue (P1.15) says
  who may create channels and manage their members. Protected people are
  never added without their acceptance (ADR 0022, P1.12). A chat is not
  owned by one group: its members are its own list, so chats across groups
  can come later.
- **Child safety (ADR 0047).** No adult is ever alone with a child: when a
  leader is in a chat with children, their guardians are added
  automatically with the whole history. Other adults cannot start direct
  messages with someone else's child. Children of all ages may chat with
  each other (for now within their group). Guardians see which chats their
  child is in and may join any of them; children always see that parents
  can join and which have; guardians of a group's children see who is in
  the group's chats. Leaders may join the children's chats of their group.
  Messages are kept without a time limit; reporting takes one tap. Every
  country pack flags whether a background check is required to write to
  children, and a club may require it where its pack does not. The chat
  prompt describes these rules clearly in the README, the help pages and
  the privacy notice.
- **Later:** a reviewing bot that alerts the club's safeguarding officers
  (rule signals, then classifiers and image checks), never punishes
  (ADR 0047).
- **Aggregated views, few clicks.** The app lists the channels the person
  is in under **"Mina kanaler"** (unread first, the latest message per
  channel), and each group's page lists its channels. The web app has the
  same.
- **Push per channel.** Push notifications in the app, set per channel (all
  messages, mentions only, off) on top of the notification settings, quiet
  hours and daily email of P1.7 (ADR 0039).
- Moderation (reporting, removing messages, muting a member), retention
  per club, history and audit as for other personal data.

**Aggregation is a general rule**, not only for chat: wherever a person has
the same kind of thing in several groups or clubs (channels, activities,
answers to give, documents, duty shifts), the app gives one "Mina …" list
across them, so nobody has to click through every group.

**Car pooling (ADR 0048)**, for matches, cups and trainings far away:

- The activity's creator (or the series, for trainings) chooses the
  transport: own transport ("Deltagarna tar sig dit själva", meeting time
  and place, the car pool opens) or shared transport (a rented bus: only
  the meeting place).
- Parents and adult participants offer a car with N seats, or "kan köra om
  det behövs"; the return trip is a copy of the outward one, editable.
  Guardians book seats for their children; children book themselves from an
  age their guardian chooses (default the country pack's, else 13).
- No adult alone in a car with a single child who is not their own without
  the guardian's active confirmation, whoever drives.
- "Mina samåkningar"; leaders see who has no ride.
- Mileage statistics from the distance stored with each place in the
  club's list of places (every leader may create and edit places by
  default; the driver may correct a drive). Members settle among themselves
  (the statistics public in the group when the group says so) or the club
  reimburses at a club rate (the country pack's tax-free rate as a guide).
  Kept until explicitly deleted. Events use the same car pools. Claims are **attested** in a
  general attestation flow (first the activity's creator, otherwise group
  or club attesters; never one's own claim) that later serves all expenses;
  payment in Phase 3.

**New permissions in Phase 2** (proposed; each prompt settles the names
and adds them to the catalogue, `permission-catalogue.ts`, with the template
roles that get them by default, P1.15 decision 5):

| Permission | Scope | What it allows | Default template roles | Source |
|---|---|---|---|---|
| `group.channels.create` | group | Create chat channels in the group and choose their members | participants (`member`, children included), group leaders (`head_coach`, `assistant_coach`, `team_manager`), owners of the group | chat; children's channels follow ADR 0047 (visible to guardians and leaders, who may join) |
| `group.channels.manage` | group | Manage channels others created in the group (members, archiving) | `head_coach`; owners of the group | chat |
| `club.channels.create` | club | Club-wide channels (the board, all leaders) | `club_manager`, `chair` | chat |
| `club.safeguarding.handle` | club | Receive reports, read reported chats (two-person rule, logged), close cases | `safeguarding_officer` | ADR 0047 |
| `club.locations.create` (widened) | club | Create and edit all places, their distance included | every leader in the club (as today: anyone who leads a group) | ADR 0048 |
| `group.expenses.attest` | group | Attest expense claims in the group (never one's own) | `head_coach`, `team_manager` | ADR 0048 |
| `club.expenses.attest` | club | Attest expense claims anywhere in the club | `treasurer` | ADR 0048 |
| `club.carpools.manage` | club | Delete old car-pool data and statistics; set the mileage rate | `club_manager`, `treasurer` | ADR 0048 |
| `club.background_checks.manage` | club | Record and follow up leaders' background checks; the club's stricter requirement | `club_manager`, `registrar` | background checks, ADR 0047 |

Settings that are not permissions: a group's "car-pool statistics public in
the group" (group leaders), a guardian's age for a child booking seats
themselves (the guardian).

The rest of the phase: calendar invitations by email with Accept/Decline
from the native calendar (iMIP, ADR 0021) · message board · bulk email with
bounce handling · documents (statutes, minutes, versions; club
settings taken from adopted governing documents, opt-in per club, ADR 0037)
· board meetings (agenda, minutes, decisions) · background-check tracking
(clearances, country packs SE/NO) · LOK-stöd reporting and IdrottOnline
export · volunteer duty schedules.

## Phase 3 — Money and content

Team cash desk · member fees, invoicing, Swish/card payments · paying
attested expense claims (mileage from car pools first, ADR 0048) · club budget ·
training plan library (versioning, sharing, copying, licences) · sponsors/ads ·
public club website pages · facility booking.

## Phase 4 — Heavy and specialised

Live streaming and recordings (a video broadcast started from a chat
channel, e.g. a match sent to everyone in a group, including supporters
such as a grandparent who is in the group to watch its matches; viewers in the
channel, recordings kept per the club's retention) · staff time reporting and salary data with
payroll export · bookkeeping integrations (SIE, Fortnox, Visma) · more country
packs · federation integrations · public API for third parties.
