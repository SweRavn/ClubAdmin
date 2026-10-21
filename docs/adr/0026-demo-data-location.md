# 0026 — Demo data as data files in `docs/demodata/`, seeded by the API app

**Status:** Accepted (before P0.8). Resolves [#4](https://github.com/SweRavn/ClubAdmin/issues/4).

**Context.** The demo scenario (`docs/seed-data.md`) must be written through
the domain services, so invariants, audit events and record history come out
as in real use. The services live in `apps/api`, and packages may not import
apps, so the seed framework could not live in `packages/db/seed/` as the P0.8
prompt said. The demo content is also something people read: personas, clubs
and their relationships are referred to in bug reports, tests and manual
testing.

**Decision.**
- **The demo data is data, under `docs/demodata/`:** JSON files (no new
  dependency) for clubs, groups, personas with their fixed UUIDs, family
  relationships, memberships, roles, waiting lists, the replayed history and
  the persona picker's descriptions and tags. Each file is validated with Zod
  schemas from `packages/shared` when it is loaded, and `docs/seed-data.md`
  stays the narrative description of the same data.
- **The runner lives in the API app** (`apps/api/src/seed/`): it reads the
  data files and writes through the domain services with the persona as
  actor. Per-module steps are `apps/api/src/seed/steps/<module>.ts`; a module's
  data goes into its own file in `docs/demodata/`.
- Generated volume (fillers for group sizes, the `load` scenario) stays code,
  with a fixed Faker seed; only named, hand-written content is a data file.
- `pnpm db:seed` and `pnpm db:reset` keep their names and run the API app's
  seed entry point.
- **Seed mode** (P0.8): to replay changes with their past times, history
  takes `app.seed_time` and skips backdating updates (`app.seed_skip_history`)
  only in a database with a row in `app_meta.seed_mode`, which the app roles
  cannot write; `db:seed`/`db:reset` write it as superuser in development.

**Consequences.** No package imports an app; the seed uses the same code
paths as the API. Demo content can be read and reviewed without reading
TypeScript, and changes to it show up as data diffs. `docs/demodata/` is
loaded by code, so it must stay valid (a test loads every file); the SPDX
header rule does not apply to JSON.
