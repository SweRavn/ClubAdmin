# Development

How to run ClubAdmin on your own machine. Everything runs locally; nothing is
sent to external services.

## Prerequisites

| Tool | Notes |
|---|---|
| Node.js | Version 24, exact version in `.nvmrc`. Install with fnm or nvm (see the README); the system package is often too old. |
| pnpm | Via Corepack: `corepack enable` (version is pinned in `package.json`). |
| Docker | Docker Desktop (macOS, Windows) or Docker Engine with the Compose v2 plugin (Linux). On Windows, work inside **WSL2** with Docker Desktop's WSL integration. |
| Free ports | 80, 443, 5432, 6379, 3900, 3903, 1025, 8025 on 127.0.0.1 (all configurable in `.env.local`). |

`pnpm dev:doctor` checks all of this and tells you how to fix problems.

### Windows (WSL2)

- Clone the repository **inside WSL** (e.g. `~/ClubAdmin`), not under
  `/mnt/c/...`: the Windows drive is slow from WSL and file watching does not
  work there. `pnpm dev:doctor` warns about this.
- Docker Desktop must have *Settings → Resources → WSL integration* enabled for
  your distro; then `docker version` in WSL shows a server. Without it the doctor
  reports `spawnSync docker ENOENT`.
- `pnpm dev:trust-ca` exports the certificate and prints the PowerShell command
  that makes Windows browsers trust it; run that command in Windows.
- Windows browsers reach `https://clubadmin.localhost` because Docker Desktop
  publishes the ports on Windows as well.

## First run

```
corepack enable
pnpm install
pnpm dev:services      # first start downloads images (a few minutes)
pnpm dev:trust-ca      # once: trust the local HTTPS certificates (asks for your password)
pnpm dev:smoke         # optional: checks every service end to end
```

`pnpm dev:services` creates **`.env.local`** with random secrets for this
machine (git-ignored, never commit it). Apps and scripts read `.env` first and
then `.env.local`.

## Daily workflow

```
pnpm dev               # start services and all apps in watch mode
pnpm dev:down          # stop services, keep data
```

| What | Where |
|---|---|
| Web app (its `/api` proxies to the API with the session's tokens) | https://clubadmin.localhost |
| API directly | https://api.clubadmin.localhost |
| Login (Zitadel) | https://auth.clubadmin.localhost (admin user and password in `.env.local`) |
| Emails sent by the system | http://127.0.0.1:8025 or https://mail.clubadmin.localhost |
| PostgreSQL | `127.0.0.1:5432`, connection string `DATABASE_ADMIN_URL` in `.env.local` |
| Valkey | `127.0.0.1:6379` |
| Object storage (S3 API) | `http://127.0.0.1:3900`, buckets `clubadmin-files`, `clubadmin-backups` and `clubadmin-files-replica` (the last two with the separate backup key) |

When the web app is not running, https://clubadmin.localhost shows a
placeholder page served by Caddy.

## Logging in

- **As anyone (DEV_AUTH):** https://clubadmin.localhost/login shows a
  persona picker, grouped by club, with the demo personas (`pnpm dev` seeds them on its first
  start; `pnpm db:reset` starts over, see `seed-data.md`), each with what it
  tests, and everyone else who has a login. Tick "as if logged in with two-factor authentication" to test
  MFA-gated pages. `.env.local` has `DEV_AUTH=true`; it is refused outside
  development.
- **For real (Zitadel):** "Log in with email" or "Create an account" on the
  same page. Sign-up sends a verification code to Mailpit
  (http://127.0.0.1:8025). https://clubadmin.localhost/me shows who you are,
  `/me/sessions` where you are logged in.
- `pnpm dev:services` runs `pnpm auth:configure`, which applies
  `infra/zitadel/` to Zitadel and writes the client IDs to `.env.local`. Run it
  again after changing `infra/zitadel/`. The Zitadel console is at
  https://auth.clubadmin.localhost/ui/console (admin in `.env.local`).

## End-to-end tests

With services, API and web app running (`pnpm dev`):

```
pnpm --filter @clubadmin/web exec playwright install chromium   # once
docker compose --project-name clubadmin cp zitadel:/zitadel/bootstrap/admin.pat .local/admin.pat
ZITADEL_PAT=$(cat .local/admin.pat) pnpm --filter @clubadmin/web test:e2e
```

The suite runs against `next dev` with DEV_AUTH: login, protected identity,
language and time zones, cross-club access, "viewing as", navigation, axe
accessibility checks and the development CSP. The production build is
checked separately (as in CI, ADR 0027): stop `pnpm dev`'s web app, then

```
set -a; . ./.env.local; set +a
cd apps/web
NODE_ENV=production DEV_AUTH=false pnpm build
NODE_ENV=production DEV_AUTH=false pnpm start &       # behind Caddy on https://clubadmin.localhost
E2E_PRODUCTION=1 pnpm test:e2e                         # strict CSP, Trusted Types, headers
pnpm bundle:check https://clubadmin.localhost "$(node scripts/test-session.ts 0199a000-0000-7000-8000-000000000005)" / /groups/0199a000-0000-7000-8002-000000000007
CHROME_PATH=/path/to/chrome pnpm lighthouse            # LCP, TBT, CLS, script size, accessibility
```

The signed-in pages of the production build are reached with a short-lived
test session written to Valkey (`scripts/test-session.ts`); the API must run
with DEV_AUTH for its token to be accepted.

The tests sign up through the real Zitadel pages (reading the code from
Mailpit), enrol TOTP through Zitadel's API (hence the token), and log in with
DEV_AUTH. CI runs them in the services job.

## API and worker

`pnpm dev` also starts the API (port 4000) and the worker in watch mode; they
recompile and restart when you save a file.

| What | Where |
|---|---|
| API through Caddy | https://api.clubadmin.localhost/api/v1/meta/version |
| API directly | http://127.0.0.1:4000 (health: `/health/live`, `/health/ready`) |
| OpenAPI document | https://api.clubadmin.localhost/api/v1/openapi.json (development only) |

After changing an endpoint, run `pnpm api:client` and commit the regenerated
`packages/api-client` files (a test fails otherwise). `pnpm test:integration`
runs the tests that need the local services.

## Mobile app

The Expo app (`apps/mobile`, ADR 0028) talks to the same local services over
HTTPS (`https://api.clubadmin.localhost`, Zitadel at
`https://auth.clubadmin.localhost`). `pnpm dev` does not start Metro; run the
services and the API (`pnpm dev`), then:

```sh
pnpm --filter @clubadmin/mobile android   # build and run a development build on the emulator/device
pnpm --filter @clubadmin/mobile ios       # macOS: on the iOS simulator
pnpm --filter @clubadmin/mobile start     # Metro only, for an installed development build
```

You need the Android SDK (Android Studio) with an emulator image
(Google APIs, API 34+, x86_64 or arm64), JDK 17, and on macOS Xcode for iOS.
On WSL, build for Android from WSL with the SDK installed there, or run
Metro in WSL and the emulator on Windows (`adb` over TCP); iOS needs a Mac.

- **Variants:** `APP_VARIANT=development` (default; bundle ID
  `org.clubadmin.app.dev`, scheme `clubadmin-dev://`, persona picker, trusts
  Caddy's local CA), `preview` and `production` (`APP_VARIANT=production
  pnpm exec expo prebuild ...`). Release builds must set `APP_VARIANT`.
  The build reads `AUTH_MOBILE_CLIENT_ID`, `AUTH_PROJECT_ID`,
  `AUTH_ISSUER` and `MOBILE_API_URL` from the environment (`set -a; .
  ./.env.local; set +a` before building), and `EXPO_UPDATES_URL` for
  over-the-air updates.
- **iOS simulator:** it shares this machine's network; `pnpm dev:trust-ca
  --ios` adds Caddy's CA to the booted simulators. The names must resolve
  (see `pnpm dev:doctor`).
- **Android emulator:** start it, then `pnpm dev:trust-ca --android`: it
  puts Caddy's CA in the emulator's user store (for Chrome, which shows the
  Zitadel login) and forwards port 443 on the emulator to this machine
  (`adb reverse`, needs a Google APIs image where `adb root` works; run it
  again after the emulator restarts). The emulator must resolve
  `*.clubadmin.localhost` to its own loopback: on Linux with
  systemd-resolved this works out of the box; otherwise start the emulator
  with `-dns-server` pointing at a resolver that answers them (CI uses
  dnsmasq with `--address=/clubadmin.localhost/127.0.0.1`).
- **Windows (WSL2), step by step:** `android-emulator.md` (the emulator in
  Windows, `adb` through `packages/devtools/wsl/adb`, the names in the
  emulator's hosts file, building in WSL). It also covers installing the
  build CI keeps on every push (artifact `clubadmin-android-development`),
  which needs no Android build tools.
- **Rebuilding:** leave out `--clean` on `expo prebuild` unless native
  dependencies or `app.config.ts` changed; it deletes `android/` and with it
  everything Gradle has compiled.
- **Airplane mode in the emulator does not cut `adb reverse`:** the app
  believes it is offline, but a persona login still reaches the API. For a
  real loss of the connection, also `adb reverse --remove-all`
  (`android-emulator.md`, "Test").
- **Logging in:** development builds show the persona picker (`DEV_AUTH`,
  tokens from `POST /api/v1/dev/tokens`); "Log in with email" uses Zitadel
  in the system browser.
- **Tests:** `pnpm --filter @clubadmin/mobile test` (Jest, also part of
  `pnpm test`); end-to-end flows with [Maestro](https://maestro.dev) in
  `apps/mobile/maestro/` (`maestro test -e APP_ID=org.clubadmin.app.dev -e
  APP_SCHEME=clubadmin-dev apps/mobile/maestro/03-language.yaml`; CI runs
  them all, see `apps/mobile/scripts/ci-android-e2e.sh`).
- **Checks:** `pnpm --filter @clubadmin/mobile bundle:check` (production
  bundle without development code, size budget), `pnpm licenses:check
  --mobile`, and after changing dependencies `pnpm --filter
  @clubadmin/mobile licenses:generate` (the About screen's licence list).

## Database

`pnpm dev:services` creates the database roles and applies all migrations.
Connect with `DATABASE_URL` (the app role, subject to row-level security) or
`DATABASE_ADMIN_URL` (superuser) from `.env.local`. After pulling new
migrations, run `pnpm db:migrate` (or `pnpm dev:services` again).

`pnpm test:integration` clones a migrated template database per test file;
the template is rebuilt automatically when migrations change.

PostgreSQL runs from the image in `infra/backup/` (PostgreSQL 18 with
pgBackRest); `pnpm dev:services` builds it the first time and whenever
`infra/backup/` changes (Alpine's package mirror must be reachable).

### Backups

Off by default. `pnpm dev:services --backup` sets `BACKUP_ENABLED=true` in
`.env.local` (set it to `false` to turn backups off again), archives WAL and
starts the backup sidecar, which takes a first full backup into Garage's
`clubadmin-backups` bucket. Then:

```sh
pnpm ops:backup diff          # a backup now
pnpm ops:verify-backup        # restore into a temporary container and check it
pnpm dev:logs backup
pnpm db:reset --scenario minimal && bash infra/backup/ci-drill.sh   # the CI drill
```

Settings, schedules and restores: `infra/backup/README.md` and
`infra/backup/runbooks/`.

## Commands

| Command | Does |
|---|---|
| `pnpm dev` | Start services, then `turbo run dev` for all apps |
| `pnpm dev:services [--full] [--backup]` | Start services only; `--full` also starts ClamAV (slow first start); `--backup` turns on backups (kept in `.env.local`) |
| `pnpm dev:down` | Stop services; data is kept |
| `pnpm dev:logs [service]` | Follow logs, e.g. `pnpm dev:logs zitadel` |
| `pnpm dev:clean [--yes]` | Stop services and **delete all their data** |
| `pnpm dev:doctor` | Check tools, ports, names, certificates and service health |
| `pnpm dev:trust-ca [--print]` | Install Caddy's local CA in the OS trust store; `--ios` booted simulators, `--android` the running emulator (also forwards port 443) |
| `pnpm dev:smoke` | End-to-end check of every service (also run in CI) |
| `pnpm auth:configure [--print]` | Apply `infra/zitadel/` to Zitadel (idempotent); `--print` shows the results instead of writing `.env.local` |

## Resetting

- Empty databases, files and emails: `pnpm dev:clean`, then `pnpm dev:services`.
- Fresh secrets too: `pnpm dev:clean`, delete `.env.local`, then `pnpm dev:services`.
  (Secrets are baked into the data volumes on first start, so always clean
  before deleting `.env.local`.)

## Troubleshooting

- **Certificate warnings in the browser:** run `pnpm dev:trust-ca`. On Linux,
  Chrome and Firefox use their own store: import `.local/caddy-root.crt` under
  Settings → Certificates → Authorities. Restart the browser.
- **`clubadmin.localhost` does not resolve:** most systems resolve `*.localhost`
  to 127.0.0.1 automatically. If not, `pnpm dev:doctor` prints the line to add
  to `/etc/hosts`.
- **Port already in use:** change the port in `.env.local` (e.g.
  `CADDY_HTTPS_PORT=8443`) and restart with `pnpm dev:down && pnpm dev:services`.
  With a non-standard HTTPS port, URLs include it (`https://clubadmin.localhost:8443`).
- **A service is unhealthy:** `pnpm dev:logs <service>`. Zitadel needs Postgres
  and takes up to a minute on first start.
- **A container does not start after Docker Desktop or WSL restarted**
  (`error mounting ... docker-desktop-bind-mounts ... no such file or directory`):
  Docker Desktop has lost the container's bind-mount source. `pnpm dev:services`
  recreates containers that did not start once by itself; by hand:
  `docker compose -p clubadmin rm -sf <service>`, then `pnpm dev:services`.
- **`unable to get local issuer certificate` while configuring Zitadel:** the
  certificate Caddy serves does not verify with its own local CA.
  `pnpm dev:services` recreates Caddy once; if that is not enough it prints the
  served chain. If the issuer is not "Caddy Local Authority", another program
  answers on the HTTPS port; otherwise start over with a new CA:
  `pnpm dev:down && docker volume rm clubadmin_caddy-data && pnpm dev:services && pnpm dev:trust-ca`.
- **Docker Hub rate limit (HTTP 429):** log in with `docker login` or wait and retry.

See also [`infra/docker/README.md`](../infra/docker/README.md) for details
about each service.
