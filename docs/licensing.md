# Licensing

ClubAdmin is licensed under **AGPL-3.0-only** (see `LICENSE`). An additional
app-store permission is proposed below and awaits the maintainer's decision.

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
| Socket.IO / `ws` | MIT |
| Next.js | MIT |
| React | MIT |
| React Native | MIT |
| Expo SDK, Expo Router | MIT |
| TanStack Query | MIT |
| react-native-mmkv | MIT |
| i18next, i18next-icu | MIT |
| `openid-client` / `jose` (OIDC/JWT) | MIT |
| Stripe SDK (`stripe`) | MIT |
| @faker-js/faker (seed data) | MIT |
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

Renovate (AGPL-3.0), OSV-Scanner (Apache-2.0), Trivy (Apache-2.0), Lighthouse
CI (Apache-2.0), k6 (AGPL-3.0), Weblate (GPL-3.0-or-later), CodeQL (free for
open-source repositories on GitHub; proprietary, CI use only). No licence
conflict.

### Commercial services (optional, behind provider interfaces)

Email providers, Stripe, Swish, Expo Push service / EAS Build, video providers
(api.video, Mux), eID brokers (Criipto, Signicat), Fortnox. These are used
through APIs; there is no licence conflict, and each has an open alternative or
can be switched off so self-hosters are never forced to use them.
(EAS Build is optional: the apps can be built locally or in CI with
open tooling.)

## Mobile app stores — action needed

Apple's App Store terms add usage restrictions that the FSF considers
incompatible with the (A)GPL. When **all** copyright holders agree, this is
resolved. Recommended:

1. Add an **additional permission** under AGPL-3.0 section 7 to `LICENSE`
   (a `LICENSE-EXCEPTION` notice) that allows distributing the mobile apps
   through app stores despite their terms.
2. Require every contribution to be made under AGPL-3.0 *including* that
   permission (stated in `CONTRIBUTING.md`, enforced by DCO sign-off).

This must be in place **before the first external contribution**, because it
cannot be added later without every contributor's consent.

## Contributor terms

- Default: **Developer Certificate of Origin (DCO)** sign-off on every commit.
  Simple and contributor-friendly.
- If the maintainer may want to dual-license later (e.g. sell a commercial
  licence), a **Contributor Licence Agreement (CLA)** would be needed instead.
  Decide before accepting external contributions. Recorded in ADR 0012.
