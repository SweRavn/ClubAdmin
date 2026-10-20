# Roadmap

Each work package becomes a prompt in `docs/prompts/` and a GitHub issue, and
is delivered as one or a few PRs.

## Phase 0 — Foundation

| ID | Work package |
|---|---|
| P0.1 | Monorepo scaffolding (pnpm, Turborepo, TS config, lint, format, CI, licence check, DCO) |
| P0.2 | Local environment: docker compose (Postgres, Valkey, Zitadel, Garage, Caddy, Mailpit), `pnpm dev` |
| P0.3 | API skeleton: NestJS/Fastify, config, health, OpenAPI from Zod, problem-details errors, OpenTelemetry, log redaction |
| P0.4 | Database foundation: Drizzle, migrations, roles (owner/app/operator), `withTenant` + RLS helpers, audit events, record-history trigger (ADR 0017), outbox |
| P0.5 | Authentication: Zitadel OIDC (web BFF + mobile PKCE + API token validation), `DEV_AUTH` persona login |
| P0.6 | Authorization engine: relationship model (incl. group owners and group hierarchy), policy DSL, endpoint policy enforcement, `PersonVisibility` service for protected identity (ADR 0022), test helpers |
| P0.7 | Core domain: people (no email), accounts (unique login email), clubs, groups + group owners, seasons, memberships, member numbers, roles, guardianships, club profiles, protected-identity flags |
| P0.8 | Seed framework + demo scenario personas (`seed-data.md`) |
| P0.9 | Web shell: Next.js, layout, club switcher, i18n (sv/en/nb), auth flow, "Source code" link |
| P0.10 | Mobile shell: Expo app, login, club switcher, i18n, persisted cache |
| P0.11 | Backup sidecar + restore runbooks + `ops:verify-backup` |
| P0.12 | Entitlements service + optional billing module skeleton |

## Phase 1 — MVP

| ID | Work package |
|---|---|
| P1.1 | Self sign-up, club creation, club managers (multiple, hand-over), join policies and requests, invitations (ADR 0018) |
| P1.2 | Member register UI (search, filter, export) with field-level permissions |
| P1.3 | Guardian/child management: "Add child" without email, invite co-guardian, merge duplicates, "give own login" with the child's own email, relative access, age transitions |
| P1.4 | Activities: recurring trainings, matches, locations, in-app calendar |
| P1.5 | Responses (attending / not attending) and attendance taking |
| P1.6 | Events with sign-up forms, deadlines, capacity, waiting lists |
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
versions) · board meetings (agenda, minutes, decisions) · background-check
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
