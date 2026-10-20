# Contributing

Thank you for helping! ClubAdmin is in its design phase; the foundation
documents in `docs/` describe what we are building.

- Read `CLAUDE.md` (it applies to humans too) and the relevant docs/ADRs.
- Pick an issue, or open one to discuss a change before larger work.
- Run `pnpm lint && pnpm typecheck && pnpm test && pnpm commits:check` before pushing.
- Use Conventional Commits and sign off every commit (`git commit -s`), which
  certifies the [Developer Certificate of Origin](https://developercertificate.org/).
- By contributing you agree that your contribution is licensed under
  AGPL-3.0-only, including the additional app-store distribution permission
  in `LICENSE-APP-STORE-EXCEPTION.md`.
- Dependencies used by the mobile app must not be GPL, LGPL or AGPL (see
  `docs/licensing.md`).
- Security issues: see `SECURITY.md`, never a public issue.
