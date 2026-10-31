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
| P1.7 | Notifications: email (templates, i18n), push, in-app; user preferences |
| P1.8 | Privacy: consents, "download my data", leave club, anonymisation and retention jobs |
| P1.9 | Audit log and record-history UI ("History" panel on detail pages) |
| P1.10 | Groups admin: group owners, group hierarchy, waiting lists with offers and admission (ADR 0019) |
| P1.11 | Calendar subscriptions: secret iCal feeds (my schedule / group / club) with one-click answer links (ADR 0021) |
| P1.12 | Protected identity UI: flags, crossed-camera icon, chat-acceptance flow, access log (ADR 0022) |
| P1.13 | Billing: plans, subscriptions, invoices (only active with `BILLING_ENABLED`) |

## Phase 2 — Communication and compliance

Chat rooms (group rooms, moderation, child-safety rules, protected-identity acceptance) ·
calendar invitations by email with Accept/Decline from the native calendar (iMIP, ADR 0021) · message board ·
bulk email with bounce handling · car pooling · documents (statutes, minutes,
versions; club settings taken from adopted governing documents, opt-in per
club, ADR 0037) · board meetings (agenda, minutes, decisions) · background-check
tracking (clearances, country packs SE/NO) · LOK-stöd reporting and
IdrottOnline export · volunteer duty schedules.

## Phase 3 — Money and content

Team cash desk · member fees, invoicing, Swish/card payments · club budget ·
training plan library (versioning, sharing, copying, licences) · sponsors/ads ·
public club website pages · facility booking.

## Phase 4 — Heavy and specialised

Live streaming and recordings · staff time reporting and salary data with
payroll export · bookkeeping integrations (SIE, Fortnox, Visma) · more country
packs · federation integrations · public API for third parties.
