# Docker services

`compose.yml` defines the backing services; `compose.dev.yml` adds development
settings. Use the `pnpm dev:*` scripts (see [`docs/development.md`](../../docs/development.md));
they pass the project name (`clubadmin`) and the `.env`/`.env.local` files.

| Service | Image | Purpose | Dev port (127.0.0.1) |
|---|---|---|---|
| `postgres` | PostgreSQL 18 | Databases `clubadmin` (app) and `zitadel`; `pg_stat_statements` enabled. Application roles are created in P0.4. | 5432 |
| `valkey` | Valkey 9 | Cache, rate limits, pub/sub. No persistence (ADR 0010). | 6379 |
| `zitadel` | Zitadel v4 | Identity provider (ADR 0005). First start creates the ClubAdmin instance, an admin user, and a machine user whose token is written to `/zitadel/bootstrap/admin.pat` (volume `zitadel-bootstrap`) for `pnpm auth:configure` (P0.6). | via Caddy |
| `zitadel-login` | Zitadel login UI v2 | Login pages under `/ui/v2/login`. | via Caddy |
| `garage` | Garage v2 | S3-compatible object storage (ADR 0011). `pnpm dev` applies the single-node layout and creates the buckets and access key from `.env.local` through the admin API. | 3900 (S3), 3903 (admin) |
| `mailpit` | Mailpit | Catches all outgoing email (dev only). | 1025 (SMTP), 8025 (UI) |
| `caddy` | Caddy 2 | HTTPS with a local CA. `clubadmin.localhost` → web (3000) and `/api` → API (4000) on the host; `auth.clubadmin.localhost` → Zitadel; `mail.clubadmin.localhost` → Mailpit. | 80, 443 |
| `clamav` | ClamAV | Virus scanning for uploads (Phase 2). Profile `full` only. | — |

## Notes

- **Image pinning:** every image is pinned by version and digest. Renovate
  opens update PRs.
- **Postgres init:** `postgres/init/01-databases.sh` runs only when the data
  volume is first created. Changing it requires `pnpm dev:clean`.
- **Zitadel secrets** (`ZITADEL_MASTERKEY`, database password) are fixed into
  the data on first start. Keep `.env.local` and the volumes together.
- **Garage** binds to IPv4 (`0.0.0.0`), because IPv6 is not available in every
  Docker setup.
- **Self-hosting:** `compose.yml` is the starting point for the self-hosted
  deployment. Production settings (real certificates, app containers, backups,
  no published database ports) are added in later packages.
