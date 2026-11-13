# ClubAdmin

**Open-source management system for sports clubs and similar associations.**

ClubAdmin helps clubs run their members, teams, activities, communication and
administration in one place, on the web, Android and iOS. It is inspired by
SportAdmin, MyClub and laget.se, but free and open source
(AGPL-3.0). It can be used as a hosted service or self-hosted by organisations
that have the capacity to run it.

> **Status:** Phase 1 is in place: the API, the background worker, the web
> app and the Android/iOS app run end to end on demo data. Phase 2
> (communication and compliance) is next; see the [roadmap](docs/roadmap.md).
> There are no release dates.

## What it does today

- **Members, families and groups.** One person, many clubs and roles;
  guardians and children (with or without their own login), bonus parents,
  contact persons; the member register with filters and CSV export; adding
  members by hand or importing a file
  ([domain model](docs/domain-model.md)).
- **Joining.** Sign-up and login through Zitadel, finding a club and
  applying, invitations by link, code or email, creating a club, handing
  over club management ([ADR 0018](docs/adr/0018-self-signup-club-managers.md)).
- **Groups.** Teams, sections and training groups in a hierarchy, owners,
  seasons and capacity, waiting lists with offers and admission
  ([ADR 0019](docs/adr/0019-groups-owners-waitlists.md),
  [ADR 0043](docs/adr/0043-waiting-lists.md)).
- **Activities.** Trainings, matches and meetings; recurring series like a
  calendar app (weekly, every other week, the first Wednesday of the month,
  until further notice), removed dates and holidays; group and club
  calendars and "My schedule" across clubs
  ([ADR 0034](docs/adr/0034-activities-and-schedule.md)).
- **Answers and attendance.** "Are you coming?" with deadlines and a request
  sent a chosen time before each session, call-ups for matches, attendance
  taking ([ADR 0035](docs/adr/0035-responses-and-attendance.md)).
- **Events with sign-up**, places and waiting lists
  ([ADR 0038](docs/adr/0038-events-and-sign-up.md)).
- **Notifications** in the app, by push and by email, with per-person
  settings ([ADR 0039](docs/adr/0039-notifications.md)).
- **Chat** in groups and the club, in real time on the web and in the app:
  open and closed channels, direct messages, edits kept, push per channel.
  Built for children: no adult is alone with a child (their parents are
  added), parents see their child's chats and may join visibly, one-tap
  reports to the club's safeguarding officers, who read a reported chat
  only when two of them agree ([ADR 0047](docs/adr/0047-child-safety-in-chat.md),
  [DPIA](docs/dpia-chat.md))
- **Calendar subscriptions** (iCal) with one-click answer links
  ([ADR 0044](docs/adr/0044-calendar-feeds.md)).
- **Privacy.** Consents, leaving a club, "download my data", account
  deletion, retention, protected identity and the profile view log, record
  history and the audit log ([GDPR](docs/gdpr.md)).
- **Optional billing** for a hosted service: plans, invoices with bankgiro
  and OCR, card payments, dunning to read-only; off by default
  ([hosting and billing](docs/hosting-and-billing.md),
  [ADR 0045](docs/adr/0045-billing-invoices-and-dunning.md)).
- **Operations.** Backups with point-in-time restore and verified restores
  ([backup and restore](docs/operations/backup-restore.md)), performance
  budgets checked in CI ([performance](docs/performance.md)).

Swedish, English and Norwegian (bokmål); country packs for Sweden and Norway.

## Planned

From the [roadmap](docs/roadmap.md): club-defined roles and permissions and
club types (P1.15); then message board, bulk email, car pooling,
documents and board meetings, background-check tracking, LOK-stöd reporting
(Phase 2); team cash desk, member fees and payments, training plan library,
sponsors, public club pages, facility booking (Phase 3); live streaming,
payroll and bookkeeping integrations (Phase 4).

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
4. **Android app:** the emulator runs in Windows; `docs/android-emulator.md`
   has every step (Android Studio, `adb` from WSL, the emulator's hosts file,
   and the ready-made build from CI).

#### Troubleshooting on Windows

Problems seen on a Windows machine and how they were solved:

| Symptom | Cause | Fix |
|---|---|---|
| Explorer says `\\wsl.localhost\Ubuntu` "is not available", and `Import-Certificate` (printed by `pnpm dev:trust-ca`) says "The certificate file could not be found", although WSL works in the terminal | Windows' access to the WSL files had stopped working | `wsl --shutdown` in PowerShell, open the Ubuntu terminal again, run the `Import-Certificate` command again |
| After that, `pnpm dev:doctor` shows `garage` and `caddy` as **exited** (their logs look normal, the health status stays `starting`) | Docker Desktop did not start those containers again after the WSL restart | `pnpm dev:services` starts them |
| `pnpm dev:services` then fails with `ECONNRESET` (`Database: ECONNRESET, trying again…`) | Docker Desktop's port forwarding to the containers that kept running (PostgreSQL) was stale after the WSL restart | `pnpm dev:down && pnpm dev:services` (stops and starts all containers; data is kept). If that does not help, restart Docker Desktop |
| Firefox: **SEC_ERROR_BAD_SIGNATURE** ("Den andra partens certifikat har en ogiltig signatur") on `https://clubadmin.localhost`; Firefox's own list of certificate authorities has no Caddy entry | Caddy's local CA had been created anew (e.g. after `pnpm dev:clean` or removing the `caddy-data` volume), but Windows still trusted the old "Caddy Local Authority" root with the same name. Firefox takes the Windows roots, so it checked the new server certificate against the old root | 1. In WSL, `pnpm dev:trust-ca` (exports the current root to `.local/caddy-root.crt`), then `openssl x509 -in .local/caddy-root.crt -noout -fingerprint -sha1` shows its SHA-1. 2. In PowerShell, `Get-ChildItem Cert:\CurrentUser\Root, Cert:\LocalMachine\Root \| Where-Object Subject -like "*Caddy*" \| Format-List Subject, Thumbprint, NotBefore` lists the Caddy roots Windows trusts (`Thumbprint` is the SHA-1 without colons). 3. Remove each one with another thumbprint: `Remove-Item Cert:\CurrentUser\Root\<thumbprint>` (in `LocalMachine`, from an administrator PowerShell). 4. If the current root is not in the list, run the `Import-Certificate` command that `pnpm dev:trust-ca` printed. 5. Restart Firefox completely. Chrome and Edge use the same Windows roots |
| The login page opens on `http://localhost:3000`, but every persona answers **403 Forbidden** | Port 3000 is Next.js without Caddy; logging in only accepts forms from the app's own origin (`PUBLIC_WEB_URL`, `https://clubadmin.localhost`), and the session cookies are HTTPS-only | Open **https://clubadmin.localhost/login** instead (Chrome, Edge and Firefox resolve `*.localhost` themselves) |
| `pnpm dev:doctor` warns that `*.localhost` names do not resolve | Programs inside WSL (the API, the tools) need the names; browsers on Windows do not | Add `127.0.0.1 clubadmin.localhost api.clubadmin.localhost auth.clubadmin.localhost mail.clubadmin.localhost` to `/etc/hosts` in WSL (if it is gone after a WSL restart, to `C:\Windows\System32\drivers\etc\hosts`) |

### First run

```bash
corepack enable
pnpm install
pnpm dev:doctor      # checks Node, Docker, ports, certificates; prints fixes
pnpm dev:services    # PostgreSQL, Valkey, Zitadel, Garage, Mailpit, Caddy
pnpm dev:trust-ca    # once, so browsers trust https://clubadmin.localhost
pnpm dev             # services + apps
```

`pnpm dev` seeds the demo scenario on its first start (clubs, groups,
personas and activities, [docs/seed-data.md](docs/seed-data.md));
`pnpm db:reset` starts over. See [`docs/development.md`](docs/development.md) for
daily use and troubleshooting, and `CLAUDE.md` for all commands and rules.

### Where things are

| What | Where |
|---|---|
| The web app | https://clubadmin.localhost |
| The login service (Zitadel itself, not the app) | https://auth.clubadmin.localhost |
| The API | https://api.clubadmin.localhost/api/v1 |
| All email the system sends (Mailpit) | http://127.0.0.1:8025 |

### Logging in

- **As a demo persona:** https://clubadmin.localhost/login lists the
  personas (`DEV_AUTH`, development only), grouped by club, each with what it
  tests. Tick "as if logged in with two-factor authentication" for pages that
  need it (club managers' settings, roles).
- **With your own account:** "Create an account" on the same page. The
  verification code is sent to Mailpit, not to your real inbox. Stuck on
  Zitadel's "Activate your user account"? Use "Log in with another account"
  on the login page ([troubleshooting](docs/development.md)).
- `pnpm dev:idp-sync` makes the personas real Zitadel users (password
  `demo-password-123`).

### Joining a club

A new person completes their profile, then on the start page either
**finds a club** (`/clubs/find`) and applies (the club's managers decide;
the person gets a notice), **uses an invitation** (a link or a code), or is
**invited by email** by a club manager or registrar. In the demo:
Strandvikens VK approves applications (Anna or Sara: "Ansökningar"), IK
Norrbacka lets everyone join at once, Fjordvik IL only by invitation
(`pnpm db:seed` prints its invitation link and code).

### The mobile app

`pnpm --filter @clubadmin/mobile android` / `ios` / `start` builds and runs
the development app ([development](docs/development.md), "Mobile app");
[docs/android-emulator.md](docs/android-emulator.md) covers the emulator on
Windows/WSL and the ready-made build from CI.

### Billing on and off

Billing is off by default (`BILLING_ENABLED=false`): self-hosted
installations see nothing of it. Turn it on in `.env.local` to try plans,
invoices and the fake card provider
([hosting and billing](docs/hosting-and-billing.md)).

## Running it yourself

ClubAdmin can be self-hosted: the images and Compose files are in
[`infra/docker`](infra/docker/README.md), configuration and the optional
billing in [hosting and billing](docs/hosting-and-billing.md), and backups
and restores in [backup and restore](docs/operations/backup-restore.md).

## Documentation

| Document | Contents |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Conventions and rules for anyone (human or AI) writing code here |
| [docs/development.md](docs/development.md) | Daily development, logging in, tests, troubleshooting |
| [docs/android-emulator.md](docs/android-emulator.md) | The Android emulator on Windows/WSL, the CI build |
| [docs/vision.md](docs/vision.md) | Goals, users, scope, non-goals |
| [docs/architecture.md](docs/architecture.md) | System design, stack, repository layout |
| [docs/domain-model.md](docs/domain-model.md) | Core entities: people, clubs, teams, roles, guardians |
| [docs/security.md](docs/security.md) | Threat model and security controls |
| [docs/api/](docs/api/problems.md) | API conventions: problem details, the data export format |
| [docs/operations/backup-restore.md](docs/operations/backup-restore.md) | Backup, restore and disaster recovery |
| [docs/performance.md](docs/performance.md) | Performance budgets and design rules |
| [docs/gdpr.md](docs/gdpr.md) | Privacy and data protection |
| [docs/hosting-and-billing.md](docs/hosting-and-billing.md) | Hosted vs self-hosted, optional billing |
| [docs/licensing.md](docs/licensing.md) | AGPL-3.0 and dependency licence policy |
| [docs/seed-data.md](docs/seed-data.md) | Demo clubs and personas for development |
| [docs/roadmap.md](docs/roadmap.md) | Phases and modules |
| [docs/adr/](docs/adr/README.md) | Architecture decision records (index) |
| [docs/prompts/](docs/prompts/README.md) | Implementation prompts, one per work package (index) |

## Contributing

Read [CLAUDE.md](CLAUDE.md) first: it holds the rules (tenant isolation,
audit, privacy, i18n, performance budgets) and the commands. Commits follow
Conventional Commits and are signed off (`git commit -s`, DCO); before
pushing, run `pnpm lint`, `pnpm typecheck`, `pnpm test` and, with the
services running, `pnpm test:integration`.

## License

ClubAdmin is licensed under the [GNU Affero General Public License v3.0](LICENSE)
with an [additional permission for app-store distribution](LICENSE-APP-STORE-EXCEPTION.md).
If you run a modified version as a network service, you must offer its source
code to its users.
