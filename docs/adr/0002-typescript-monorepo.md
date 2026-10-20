# 0002 — TypeScript monorepo (pnpm + Turborepo)

**Status:** Accepted

**Context.** Backend, web and mobile share schemas, types, permission names,
translations and domain rules. The maintainer knows TypeScript, and it has the
largest contributor pool.

**Decision.** One repository, TypeScript `strict` everywhere, pnpm workspaces,
Turborepo for task caching. Node.js current LTS. Shared code in `packages/`.

**Consequences.** One toolchain, one CI. Mobile build tooling (Expo) must coexist
with Node tooling in the workspace; keep `apps/mobile` dependencies isolated
with pnpm settings Expo supports. Alternatives considered: Flutter (weak web),
Django/Python (two languages), Elixir (small pool).
