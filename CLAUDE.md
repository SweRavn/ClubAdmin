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
   event in the same transaction (`audit.record(tx, ...)`). In addition,
   **every table** gets the record-history trigger with
   `SELECT history.enable_history('public.<table>')` in its migration
   (ADR 0017); integration tests fail for tables without it unless listed in
   `packages/db/src/history-exclusions.ts`. Always write through
   `db.withTenant(...)`/`db.withActor(...)`/`db.withSystem(...)` so the actor is
   recorded. Club-owned tables also call `app.enable_tenant_rls(...)`, and
   tables with `updated_at` call `app.enable_updated_at(...)`.
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
  db/         Drizzle schema, migrations, RLS policies
  api-client/ Generated typed client from OpenAPI
  i18n/       Message catalogues (sv, en, nb, ...)
  ui/         Shared UI primitives (web)
  config/     Shared eslint/tsconfig/prettier, licence and commit checks
  country-packs/  Country-specific rules (se, no, ...)
  server-kit/ Server bootstrap shared by api and worker: config, logging, telemetry
  devtools/   pnpm dev:* tooling (docker compose, doctor, smoke test)
  ops/        pnpm ops:* operator tooling (backup verification, restores, ledger replay)
infra/
  docker/     Dockerfiles, docker-compose for dev and self-hosting
  backup/     PostgreSQL image with pgBackRest, backup sidecar, restore runbooks
docs/         Design documents, ADRs, prompts; demo data in docs/demodata (ADR 0026)
```

## Commands

Use Node.js from `.nvmrc` (current LTS) and pnpm via Corepack (`corepack enable`).

```
pnpm install
pnpm lint             # ESLint (incl. SPDX header rule) + Prettier check
pnpm lint:fix         # autofix ESLint issues and format with Prettier
pnpm typecheck
pnpm test             # unit tests (Vitest)
pnpm licenses:check   # dependency licences against packages/config/licenses.json
pnpm licenses:check --mobile   # stricter check for the mobile bundle
pnpm commits:check    # DCO sign-off + Conventional Commits for origin/main..HEAD
```

Local development (see `docs/development.md`):

```
pnpm dev              # start services (docker compose) + all apps in watch mode
pnpm dev:services     # services only (--full adds ClamAV; --backup turns on backups)
pnpm dev:down         # stop services, keep data
pnpm dev:clean        # stop services and delete their data
pnpm dev:doctor       # check tools, ports, certificates, service health
pnpm dev:trust-ca     # trust Caddy's local HTTPS CA (once)
pnpm dev:smoke        # end-to-end check of all services
pnpm auth:configure   # apply infra/zitadel/ to Zitadel (pnpm dev:services runs it)
pnpm --filter @clubadmin/web test:e2e   # Playwright: real Zitadel login and DEV_AUTH (docs/development.md)
pnpm --filter @clubadmin/web bundle:check / lighthouse   # web budgets on the production build (ADR 0027)
pnpm --filter @clubadmin/mobile android / ios / start    # mobile development build (docs/development.md, "Mobile app")
pnpm --filter @clubadmin/mobile bundle:check             # production bundle: no development code, size budget (ADR 0028)
pnpm --filter @clubadmin/mobile licenses:generate        # after changing mobile dependencies (About screen; CI checks)
pnpm dev:trust-ca --android | --ios                      # prepare the emulator / simulator for the local HTTPS services
```

API:

```
pnpm api:client       # regenerate packages/api-client (openapi.json + types); commit the result
pnpm api:breaking     # fail on breaking API changes against origin/main (ADR 0029; needs Go)
pnpm test:integration # integration tests against the local services (needs pnpm dev:services)
pnpm --filter @clubadmin/api build && pnpm --filter @clubadmin/api bench   # request-pipeline benchmark
```

Database (see `docs/architecture.md`, "Database"):

```
pnpm db:bootstrap     # roles and grants (superuser; idempotent; pnpm dev:services runs it)
pnpm db:migrate       # apply migrations as clubadmin_owner (pnpm dev:services runs it)
pnpm db:status        # pending or changed migrations
pnpm db:generate      # write a migration from changes in packages/db/src/schema
pnpm --filter @clubadmin/db bench   # cost of tenant transactions and history triggers
pnpm db:seed          # load the demo scenario (docs/seed-data.md, data in docs/demodata)
pnpm db:reset         # drop, recreate, migrate, seed; development only (--scenario demo|minimal|load)
```

Backups (see `docs/operations/backup-restore.md`, runbooks in `infra/backup/runbooks/`):

```
pnpm ops:backup full|diff|monthly|files   # run a backup now (backup sidecar)
pnpm ops:verify-backup [--time <ISO>]     # restore into a temporary container, check, record
pnpm ops:restore [--time <ISO>]           # in-place restore, replays the deletion ledger
pnpm ops:replay-ledger                    # erase everyone in the deletion ledger again
pnpm ops:object-lock                      # is the backup bucket immutable?
bash infra/backup/ci-drill.sh             # the CI backup drill against the local services
```

Dependency versions shared across packages are defined once in the `catalog:`
section of `pnpm-workspace.yaml`. New dependency versions are only installed
once they are 7 days old (`minimumReleaseAge`), and dependency install scripts
only run if listed in `onlyBuiltDependencies`.

## Coding conventions

- TypeScript `strict`, no `any` without a comment explaining why.
- Every API route is declared with `@Endpoint(...)` (schemas, access rule:
  `{ public: true }`, `{ authenticated: true }` or `{ permission, resource }`
  with a permission from `packages/shared/src/permissions.ts` and its one
  policy in `modules/authorization/authorization.policy.ts`; `@RequireMfa()`
  and `@RecentAuth(minutes)` for step-up); plain `@Get`/`@Post` routes, or a
  permission without a policy, make the API refuse to start. Read the caller
  with `@CurrentAuthorization()` (actor, checked resource, and the `context`
  to pass to services, which records on-behalf-of) or `@CurrentPrincipal()`.
  Throw `ProblemError` for expected failures; never return error objects.
- People in responses: load rows with `PeopleService.summaries(...)` and map
  them with `PersonPresenter` (hidden people are left out). Name fields and
  name columns anywhere else fail lint (`clubadmin/person-names-in-presenters`).
  Lists are keyset-paginated (`PageQuerySchema`: `cursor` = last item's ID).
- Import Zod as `import { z } from "@clubadmin/shared"`.
- Only `packages/db` imports `pg`/Drizzle drivers; everything else uses
  `createDatabase(...).withTenant/withActor/withSystem` (dependency-cruiser).
  Outbox payloads and job payloads contain IDs only.
- Packages under `packages/` are TypeScript source (no build step) with `.ts`
  import extensions and erasable syntax only; apps are compiled with SWC.
- Backend modules live in `apps/api/src/modules/<module>/` with
  `*.controller.ts`, `*.service.ts`, `*.repository.ts`, `*.policy.ts`,
  `*.schemas.ts` (re-exported from `packages/shared`), and tests next to them.
- A module may only use another module through its exported service, never its
  tables. Cross-module reactions go through domain events. Services take an
  `ActorContext`/`TenantContext` and throw `DomainError(code)` for expected
  failures (codes, never values). A module whose tables store person IDs
  declares them in `<module>.references.ts` so merging duplicate people
  covers them.
- New tables in `public` need row-level security even without `club_id`
  (global tables: policies via the `app.*` access helpers, ADR 0023).
- Database names: `snake_case`, plural tables, `id` is UUIDv7 (ADR 0020),
  `created_at`, `updated_at` on every table. Login email only on `accounts`
  (unique, case-insensitive); people never have an email column.
- Terminology: "group" in code and data (`groups`, `group_memberships`); "team"
  is one `kind` of group and a UI label.
- API: REST, JSON, `/api/v1/...`, plural resources, ISO 8601 times, errors as
  RFC 9457 problem details. `/api/v1` only grows (ADR 0029): add fields and
  endpoints, deprecate instead of removing or renaming; clients ignore
  unknown fields and enum values.
- Tests: every policy has allow and deny tests (`authorization.policy.test.ts`
  fails otherwise); every endpoint with a permission is in the permission
  matrix (`authorization.integration.test.ts`, "matrix" scenario in
  `apps/api/src/testing/scenarios.ts`), which also asserts tenant isolation (a
  user of club B gets 404 for club A).
- Commits: Conventional Commits (`feat(activities): ...`). Sign off every
  commit (`git commit -s`, DCO).
- Source files start with `// SPDX-License-Identifier: AGPL-3.0-only`.
- `apps/mobile` and anything it bundles must not depend on GPL/LGPL/AGPL
  third-party code (app-store exception, `docs/licensing.md`).
- Work happens on `main` for now (single maintainer); keep `main` green.

## When working from a prompt in `docs/prompts/`

Implement only what the prompt scopes. If you discover a needed design change,
write or update an ADR in `docs/adr/` and say so in the PR. Update the relevant
docs in the same PR as the code. Known gaps and deferred work are GitHub issues
(labels `security`, `auth`, `tech-debt`, `decision-needed`); link the issue
from the doc or ADR that describes the gap, and close it in the commit that
fixes it.
