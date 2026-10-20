# ClubAdmin

**Open-source management system for sports clubs and similar associations.**

ClubAdmin helps clubs run their members, teams, activities, communication and
administration in one place, on the web, Android and iOS. It is inspired by
SportAdmin, MyClub and the discontinued laget.se, but free and open source
(AGPL-3.0). It can be used as a hosted service or self-hosted by organisations
that have the capacity to run it.

> Status: **design phase**. No application code yet. Start with the documents below.

## Highlights (planned)

- Members, teams, guardians and children, one person with many roles across many clubs
- Activities (training, matches), attendance and LOK-stöd reporting
- Events with sign-up, car pooling
- Messaging: email, message board, team chat rooms
- Shareable training plans across clubs
- Documents, sponsors/ads, team cash desk
- Tracking of required background checks (e.g. Swedish belastningsregisterutdrag)
- Built-in GDPR tools, strong security, fast UI
- Live streaming, payroll and bookkeeping integrations (later phases)

## Getting started (development)

### Prerequisites

- **Node.js 24** (the exact version is in `.nvmrc`). Install it with a version
  manager instead of the system package, which is often older:

  ```bash
  curl -fsSL https://fnm.vercel.app/install | bash   # installs fnm
  source ~/.bashrc
  cd ClubAdmin
  fnm install && fnm use                              # reads .nvmrc
  node -v                                             # v24.x
  ```

  To switch automatically when entering the folder, use
  `eval "$(fnm env --use-on-cd)"` in `~/.bashrc`. nvm works too
  (`nvm install && nvm use`).
- **pnpm** via Corepack (bundled with Node): `corepack enable`. The pnpm version
  is pinned in `package.json`.
- **Docker** with Compose v2: Docker Desktop on macOS and Windows, Docker Engine
  on Linux.

### Windows (WSL2)

Develop inside WSL2 (Ubuntu), not in Windows directly:

1. **Clone the repository inside WSL**, e.g. `~/ClubAdmin`, not under
   `/mnt/c/...`. On the Windows drive, installs are many times slower and file
   watching does not work.
2. **Docker:** install Docker Desktop on Windows, then enable
   *Settings → Resources → WSL integration* for your Ubuntu distro and open a
   new WSL terminal. `docker version` inside WSL should show both client and
   server.
3. Install Node 24 inside WSL as above.

### First run

```bash
corepack enable
pnpm install
pnpm dev:doctor      # checks Node, Docker, ports, certificates; prints fixes
pnpm dev:services    # PostgreSQL, Valkey, Zitadel, Garage, Mailpit, Caddy
pnpm dev:trust-ca    # once, so browsers trust https://clubadmin.localhost
pnpm dev             # services + apps
```

See [`docs/development.md`](docs/development.md) for daily use and
troubleshooting, and `CLAUDE.md` for all commands and rules.

## Documentation

| Document | Contents |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Conventions and rules for anyone (human or AI) writing code here |
| [docs/vision.md](docs/vision.md) | Goals, users, scope, non-goals |
| [docs/architecture.md](docs/architecture.md) | System design, stack, repository layout |
| [docs/domain-model.md](docs/domain-model.md) | Core entities: people, clubs, teams, roles, guardians |
| [docs/security.md](docs/security.md) | Threat model and security controls |
| [docs/operations/backup-restore.md](docs/operations/backup-restore.md) | Backup, restore and disaster recovery |
| [docs/performance.md](docs/performance.md) | Performance budgets and design rules |
| [docs/gdpr.md](docs/gdpr.md) | Privacy and data protection |
| [docs/hosting-and-billing.md](docs/hosting-and-billing.md) | Hosted vs self-hosted, optional billing |
| [docs/licensing.md](docs/licensing.md) | AGPL-3.0 and dependency licence policy |
| [docs/seed-data.md](docs/seed-data.md) | Demo clubs and personas for development |
| [docs/roadmap.md](docs/roadmap.md) | Phases and modules |
| [docs/adr/](docs/adr/) | Architecture decision records |
| [docs/prompts/](docs/prompts/) | Implementation prompts, one per work package |

## License

ClubAdmin is licensed under the [GNU Affero General Public License v3.0](LICENSE)
with an [additional permission for app-store distribution](LICENSE-APP-STORE-EXCEPTION.md).
If you run a modified version as a network service, you must offer its source
code to its users.
