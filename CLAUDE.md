# CLAUDE.md

Guidance for anyone (human or AI) writing code in this repository. Read this
first, then the document relevant to your task under `docs/`.

## What this is

ClubAdmin: an open-source (AGPL-3.0), multi-tenant management system for sports
clubs. Web (Next.js), iOS/Android (Expo), backend API (NestJS on Fastify),
PostgreSQL. All TypeScript. See `docs/architecture.md`.

## Non-negotiable rules

1. **Tenant isolation.** Every club-owned table has a `club_id` column and a
   PostgreSQL row-level security (RLS) policy. Never query club data outside a
   tenant-scoped transaction (`withTenant(...)`). Never disable RLS to "make it
   work". Cross-club data (people, shared plans) is only reached through the
   explicit access paths in `docs/domain-model.md`.
2. **Deny by default.** Every API endpoint declares its required permission via
   the authorization module. An endpoint with no declared policy fails the build
   (lint rule / test). Do not check roles ad hoc in controllers.
3. **Audit and history.** Any create/update/delete of personal data,
   permissions, roles, guardianship, money or documents writes a semantic audit
   event in the same transaction. In addition, **every table** gets the generic
   record-history trigger via `enableHistory(...)` in its migration (ADR 0017);
   CI fails for tables without it unless explicitly excluded. Always write
   through `withTenant(...)`/`withActor(...)` so the actor is recorded.
4. **Protected identity and person visibility.** Never serialise a person's
   name or details except through the `PersonVisibility` presenter (ADR 0022).
   This covers API responses, exports, emails, push, calendar feeds, chat and
   history views. Calendar data never contains attendee names.
5. **Personal data.** Never log personal data (names, emails, phone numbers,
   personal identity numbers, messages). Log IDs. Sensitive fields (personal
   identity number, health notes) use field-level encryption helpers. Never
   store background-check documents, only verification metadata.
6. **Validate at the boundary.** All input is validated with the shared Zod
   schemas in `packages/shared`. The same schemas generate the OpenAPI spec.
7. **Performance budgets** in `docs/performance.md` are requirements. No N+1
   queries, all list endpoints paginate with keyset pagination, every new query
   on a large table needs a supporting index (justify in the PR).
8. **Times.** Store `timestamptz` in UTC. Store the club's IANA time zone on the
   club. Calendar-type values (birth dates, all-day events) use `date`.
9. **i18n.** No user-facing string literals in components or emails. Use message
   keys (ICU format). Swedish (`sv`) and English (`en`) must both be complete.
10. **Licences.** Only add dependencies whose licence is on the allow list in
   `docs/licensing.md`. CI enforces this.
11. **Billing is optional.** Code must work with `BILLING_ENABLED=false`
    (self-hosted). Check entitlements through the `entitlements` service, never
    billing tables directly.
12. **No secrets in the repo.** Use environment variables; `.env.example` lists
    them with dummy values.
13. **Migrations are forward-only** and must be safe to run on a live database
    (expand/contract). Never edit a merged migration.

## Repository layout (target)

```
apps/
  api/        NestJS (Fastify) REST API + WebSocket gateway
  worker/     Background jobs (Graphile Worker)
  web/        Next.js web app (members, admins, public club pages)
  mobile/     Expo (React Native) app for iOS and Android
packages/
  shared/     Zod schemas, types, domain constants, permission names
  db/         Drizzle schema, migrations, RLS policies, seed scenarios
  api-client/ Generated typed client from OpenAPI
  i18n/       Message catalogues (sv, en, nb, ...)
  ui/         Shared UI primitives (web)
  config/     Shared eslint/tsconfig/prettier
  country-packs/  Country-specific rules (se, no, ...)
infra/
  docker/     Dockerfiles, docker-compose for dev and self-hosting
  backup/     pgBackRest config, restore runbooks and scripts
docs/         Design documents, ADRs, prompts
```

## Commands (to be created in Phase 0)

```
pnpm install
pnpm dev            # start all services via docker compose + apps in watch mode
pnpm db:migrate     # apply migrations
pnpm db:seed        # load demo scenario (see docs/seed-data.md)
pnpm db:reset       # drop, migrate, seed (development only)
pnpm lint           # eslint + prettier check
pnpm typecheck
pnpm test           # unit + integration (integration uses a real Postgres)
pnpm test:e2e       # Playwright against the web app
pnpm licenses:check
```

## Coding conventions

- TypeScript `strict`, no `any` without a comment explaining why.
- Backend modules live in `apps/api/src/modules/<module>/` with
  `*.controller.ts`, `*.service.ts`, `*.repository.ts`, `*.policy.ts`,
  `*.schemas.ts` (re-exported from `packages/shared`), and tests next to them.
- A module may only use another module through its exported service, never its
  tables. Cross-module reactions go through domain events.
- Database names: `snake_case`, plural tables, `id` is UUIDv7 (ADR 0020),
  `created_at`, `updated_at` on every table. Login email only on `accounts`
  (unique, case-insensitive); people never have an email column.
- Terminology: "group" in code and data (`groups`, `group_memberships`); "team"
  is one `kind` of group and a UI label.
- API: REST, JSON, `/api/v1/...`, plural resources, ISO 8601 times, errors as
  RFC 9457 problem details.
- Tests: every policy has allow and deny tests; every endpoint has at least one
  integration test that also asserts tenant isolation (a user of club B cannot
  read club A).
- Commits: Conventional Commits (`feat(activities): ...`). Sign off every
  commit (`git commit -s`, DCO).
- Source files start with `// SPDX-License-Identifier: AGPL-3.0-only`.
- `apps/mobile` and anything it bundles must not depend on GPL/LGPL/AGPL
  third-party code (app-store exception, `docs/licensing.md`).
- Work happens on `main` for now (single maintainer); keep `main` green.

## When working from a prompt in `docs/prompts/`

Implement only what the prompt scopes. If you discover a needed design change,
write or update an ADR in `docs/adr/` and say so in the PR. Update the relevant
docs in the same PR as the code.
