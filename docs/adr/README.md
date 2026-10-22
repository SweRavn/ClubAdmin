# Architecture decision records

Short records of significant decisions, in the format: Context, Decision,
Consequences. Status is one of Proposed, Accepted, Superseded by NNNN.
Never rewrite an accepted ADR; supersede it with a new one.

| ADR | Title | Status |
|---|---|---|
| [0001](0001-record-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-typescript-monorepo.md) | TypeScript monorepo (pnpm + Turborepo) | Accepted |
| [0003](0003-modular-monolith.md) | Modular monolith on NestJS + Fastify | Accepted |
| [0004](0004-postgresql-rls-multitenancy.md) | PostgreSQL, Drizzle, shared-schema multi-tenancy with RLS | Accepted |
| [0005](0005-identity-zitadel.md) | Authentication via Zitadel (OIDC) | Accepted |
| [0006](0006-authorization.md) | In-process relationship-based authorization | Accepted |
| [0007](0007-rest-openapi.md) | REST + OpenAPI from Zod; WebSocket for realtime | Accepted |
| [0008](0008-clients-nextjs-expo.md) | Next.js for web, Expo for iOS/Android | Accepted |
| [0009](0009-jobs-in-postgres.md) | Background jobs in Postgres (Graphile Worker) | Accepted |
| [0010](0010-valkey.md) | Valkey for cache, rate limiting and pub/sub | Accepted |
| [0011](0011-object-storage.md) | S3-compatible object storage | Accepted |
| [0012](0012-licensing-contributions.md) | AGPL-3.0, dependency allow list, DCO, app-store permission | Accepted |
| [0013](0013-hosting-billing.md) | Hosted + self-hosted from the same code; optional billing | Accepted |
| [0014](0014-backup-strategy.md) | Backups: pgBackRest, immutable off-site copies | Accepted |
| [0015](0015-country-packs.md) | Country packs for country-specific rules | Accepted |
| [0016](0016-own-chat.md) | Build chat in-house instead of Matrix | Accepted |
| [0017](0017-record-history.md) | Change history for every database record | Accepted |
| [0018](0018-self-signup-club-managers.md) | Self sign-up, club creation and club managers | Accepted |
| [0019](0019-groups-owners-waitlists.md) | Groups, group owners and waiting lists | Accepted |
| [0020](0020-identifiers-and-login-email.md) | Identifiers, login email and people without email | Accepted |
| [0021](0021-calendar-subscriptions.md) | Calendar subscriptions and answering from the phone's calendar | Accepted |
| [0022](0022-protected-identity.md) | Protected identity | Accepted |
| [0023](0023-global-tables-rls.md) | Row-level security for global tables and own relationships | Accepted |
| [0024](0024-api-tokens.md) | API tokens: JWT access token plus the bound ID token | Accepted |
| [0025](0025-authorization-engine.md) | Authorization engine: relationship sets, resource scopes and visibility | Accepted |
| [0026](0026-demo-data-location.md) | Demo data as data files in `docs/demodata/`, seeded by the API app | Accepted |
| [0027](0027-web-performance-budgets-in-ci.md) | Web shell: production build, CSP with Trusted Types, performance budgets in CI | Accepted |
| [0028](0028-mobile-app.md) | Mobile app: login, development tokens, encrypted cache, updates and per-account rate limits | Accepted |
| [0029](0029-api-compatibility.md) | API compatibility: `/api/v1` only grows | Accepted |
