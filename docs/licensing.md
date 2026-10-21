# Licensing

ClubAdmin is licensed under **AGPL-3.0-only** (see `LICENSE`) with an
additional permission for app-store distribution
(see [`LICENSE-APP-STORE-EXCEPTION.md`](../LICENSE-APP-STORE-EXCEPTION.md)).
Source files carry the header `SPDX-License-Identifier: AGPL-3.0-only`; the
exception applies to the whole repository.

## Why AGPL-3.0

Anyone may use, modify and host ClubAdmin, but whoever offers a modified version
as a network service must make their source code available to its users
(section 13). This prevents closed forks of the hosted service.

Consequence for us: the web and mobile apps must show a visible **"Source code"
link** pointing to the exact source of the running version (footer + About
screen). The API exposes `/api/v1/meta/source`.

## Compatibility rules

AGPL-3.0 code may include and link code under licences that are compatible with
it:

- **Allowed (allow list):** MIT, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD,
  Apache-2.0, MPL-2.0, Zlib, Unlicense, CC0-1.0, Python-2.0, BlueOak-1.0.0,
  LGPL-2.1-or-later, LGPL-3.0, GPL-3.0, AGPL-3.0. CC-BY-4.0 for assets/data only.
- **Not allowed to be linked/bundled:** GPL-2.0-only, SSPL, BUSL/BSL, FSL,
  Elastic License, Commons Clause, CC-*-NC, "source-available" or proprietary
  licences, and packages without a licence.

**Separate programs** that we only talk to over a network or run as their own
process (database, identity provider, virus scanner, monitoring) are not part
of our program in the licence sense; their licence must only permit running
them. Even so, we prefer open-source ones so that self-hosting needs no
proprietary software.

CI runs a licence check on the full dependency tree (`pnpm licenses:check`) and
fails on anything outside the allow list. Exceptions need an ADR.

## Review of the proposed stack

Checked October 2026. Licences of individual versions must still be confirmed
by the CI check when added.

### Bundled into our code (must be compatible) — all compatible

| Component | Licence |
|---|---|
| TypeScript | Apache-2.0 |
| Node.js | MIT |
| NestJS | MIT |
| Fastify | MIT |
| Drizzle ORM / drizzle-kit | Apache-2.0 |
| Zod | MIT |
| node-postgres (`pg`) | MIT |
| Graphile Worker | MIT |
| Socket.IO / `ws` (planned) | MIT |
| Next.js | MIT |
| React | MIT |
| React Native | MIT |
| Expo SDK, Expo Router | MIT |
| TanStack Query, TanStack Virtual (`@tanstack/react-query`, `@tanstack/react-virtual`) | MIT |
| next-intl (web i18n; server-side only at P0.9) | MIT |
| Tailwind CSS (`tailwindcss`, `@tailwindcss/postcss`; build time) | MIT |
| Radix UI primitives (`@radix-ui/react-dropdown-menu`) | MIT |
| react-native-mmkv | MIT |
| i18next, i18next-icu | MIT |
| `openid-client` / `jose` (OIDC/JWT) | MIT |
| Stripe SDK (`stripe`) | MIT |
| @faker-js/faker (seed data) | MIT |
| @nestjs/common, @nestjs/core, @nestjs/platform-fastify | MIT |
| reflect-metadata | Apache-2.0 |
| rxjs | Apache-2.0 |
| fastify, @fastify/helmet, @fastify/cors, @fastify/rate-limit | MIT |
| @asteasolutions/zod-to-openapi | MIT |
| pino | MIT |
| ioredis (Valkey client) | MIT |
| graphile-worker | MIT |
| openapi-fetch | MIT |
| OpenTelemetry JS SDK and instrumentations (`@opentelemetry/*`) | Apache-2.0 |
| import-in-the-middle | Apache-2.0 |
| Vitest, Playwright | MIT, Apache-2.0 |
| pnpm, Turborepo | MIT |

### Separate services (run alongside, not linked)

| Component | Licence | Note |
|---|---|---|
| PostgreSQL | PostgreSQL License (permissive) | |
| PgBouncer | ISC | |
| Valkey | BSD-3-Clause | Chosen over Redis: Redis ≥ 7.4 was RSAL/SSPL only; Redis 8 adds AGPL-3.0 as an option, which would also work, but Valkey is permissive and community-governed |
| Zitadel | AGPL-3.0 (server, since v3); SDKs Apache-2.0 | Compatible. Keycloak (Apache-2.0) is the drop-in alternative via OIDC |
| Garage (object storage, self-host) | AGPL-3.0 | |
| SeaweedFS (alternative) | Apache-2.0 | |
| MinIO | AGPL-3.0 | **Not recommended:** community edition is source-only and in maintenance mode since late 2025 |
| Caddy | Apache-2.0 | |
| pgBackRest | MIT | |
| rclone | MIT | |
| imgproxy | MIT | |
| ClamAV | GPL-2.0-only | Fine as a separate daemon (`clamd` over a socket). **Never link `libclamav`** into our code |
| MediaMTX (streaming, self-host) | MIT | |
| OpenTelemetry Collector, Prometheus | Apache-2.0 | |
| Grafana, Loki, Tempo | AGPL-3.0 | |
| GlitchTip (error tracking) | MIT | Preferred for self-hosting. Sentry *server* is FSL (not open source); Sentry *SDKs* are MIT and work with GlitchTip |

### Development and CI tools (not distributed)

SWC (`@swc/core`, `@swc/cli`: Apache-2.0, MIT), unplugin-swc (MIT), chokidar (MIT),
openapi-typescript (MIT), dependency-cruiser (MIT), intl-messageformat (BSD-3-Clause,
catalogue check), `@axe-core/playwright` and axe-core (MPL-2.0, accessibility
checks), `@lhci/cli` and Lighthouse (Apache-2.0; its dependency
`parse-cache-control` declares "BSD" and is BSD-3-Clause, recorded as an
exception in `packages/config/licenses.json`, ADR 0027),
Renovate (AGPL-3.0), OSV-Scanner (Apache-2.0), Trivy (Apache-2.0), k6 (AGPL-3.0), Weblate (GPL-3.0-or-later), CodeQL (free for
open-source repositories on GitHub; proprietary, CI use only). No licence
conflict.

### Commercial services (optional, behind provider interfaces)

Email providers, Stripe, Swish, Expo Push service / EAS Build, video providers
(api.video, Mux), eID brokers (Criipto, Signicat), Fortnox. These are used
through APIs; there is no licence conflict, and each has an open alternative or
can be switched off so self-hosters are never forced to use them.
(EAS Build is optional: the apps can be built locally or in CI with
open tooling.)

## Mobile app stores

Apple's App Store terms add usage restrictions that the FSF considers
incompatible with the (A)GPL. We solve this with an **additional permission**
under AGPL-3.0 section 7 (`LICENSE-APP-STORE-EXCEPTION.md`), which allows
distributing the client apps through app stores as long as the full source
stays freely available and the app shows where to get it.

### Effect on dependencies

The permission only covers code whose copyright holders granted it, which means
our own code. Third-party code keeps its own licence. Therefore:

- **Server-side and separate services: no effect.** They are not distributed
  through app stores. AGPL services such as Zitadel, Garage and Grafana are
  unaffected.
- **Web app: no effect.** It is not distributed through an app store.
- **Mobile app bundle: stricter rule.** Anything compiled into the iOS/Android
  apps must be under a licence that itself allows app-store distribution:
  MIT, ISC, BSD, Apache-2.0, Zlib, 0BSD, Unlicense, CC0, and MPL-2.0 (file-level
  copyleft; we publish our source anyway). **GPL, LGPL and AGPL third-party
  code is not allowed in `apps/mobile`** or in packages it bundles, because our
  exception cannot cover it.
- Every library proposed so far for the mobile app (React Native, Expo SDK,
  Expo Router, TanStack Query, react-native-mmkv, i18next, jose, our own
  packages) is MIT or Apache-2.0, so **nothing in the proposed stack changes**.
- CI runs a separate, stricter licence check for the mobile bundle
  (`pnpm licenses:check --mobile`).

## Contributor terms

**Decision: Developer Certificate of Origin (DCO).** There are no plans to
relicense. Every commit must be signed off (`git commit -s`), certifying the
[DCO](https://developercertificate.org/). Contributions are accepted under
AGPL-3.0-only together with the app-store permission. CI checks for sign-off.
