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
| Web app (and API under `/api`) | https://clubadmin.localhost |
| Login (Zitadel) | https://auth.clubadmin.localhost (admin user and password in `.env.local`) |
| Emails sent by the system | http://127.0.0.1:8025 or https://mail.clubadmin.localhost |
| PostgreSQL | `127.0.0.1:5432`, connection string `DATABASE_ADMIN_URL` in `.env.local` |
| Valkey | `127.0.0.1:6379` |
| Object storage (S3 API) | `http://127.0.0.1:3900`, buckets `clubadmin-files` and `clubadmin-backups` |

Until the web app exists (P0.6/P0.9), https://clubadmin.localhost shows a
placeholder page served by Caddy.

## API and worker

`pnpm dev` also starts the API (port 4000) and the worker in watch mode; they
recompile and restart when you save a file.

| What | Where |
|---|---|
| API through Caddy | https://clubadmin.localhost/api/v1/meta/version |
| API directly | http://127.0.0.1:4000 (health: `/health/live`, `/health/ready`) |
| OpenAPI document | https://clubadmin.localhost/api/v1/openapi.json (development only) |

After changing an endpoint, run `pnpm api:client` and commit the regenerated
`packages/api-client` files (a test fails otherwise). `pnpm test:integration`
runs the tests that need the local services.

## Database

`pnpm dev:services` creates the database roles and applies all migrations.
Connect with `DATABASE_URL` (the app role, subject to row-level security) or
`DATABASE_ADMIN_URL` (superuser) from `.env.local`. After pulling new
migrations, run `pnpm db:migrate` (or `pnpm dev:services` again).

`pnpm test:integration` clones a migrated template database per test file;
the template is rebuilt automatically when migrations change.

## Commands

| Command | Does |
|---|---|
| `pnpm dev` | Start services, then `turbo run dev` for all apps |
| `pnpm dev:services [--full]` | Start services only; `--full` also starts ClamAV (slow first start) |
| `pnpm dev:down` | Stop services; data is kept |
| `pnpm dev:logs [service]` | Follow logs, e.g. `pnpm dev:logs zitadel` |
| `pnpm dev:clean [--yes]` | Stop services and **delete all their data** |
| `pnpm dev:doctor` | Check tools, ports, names, certificates and service health |
| `pnpm dev:trust-ca [--print]` | Install Caddy's local CA in the OS trust store |
| `pnpm dev:smoke` | End-to-end check of every service (also run in CI) |

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
- **Docker Hub rate limit (HTTP 429):** log in with `docker login` or wait and retry.

See also [`infra/docker/README.md`](../infra/docker/README.md) for details
about each service.
