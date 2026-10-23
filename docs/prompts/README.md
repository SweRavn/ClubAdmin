# Implementation prompts

Each work package in [`../roadmap.md`](../roadmap.md) gets one prompt file here,
named `<id>-<slug>.md` (e.g. `P0.4-database-foundation.md`). A prompt is handed
to an AI coding agent (or a human contributor) together with `CLAUDE.md`, and is
also posted as a GitHub issue.

Prompts reference the foundation documents and ADRs instead of repeating them.
Keep each prompt small enough for one reviewable PR (a few days of work at most).

Use [`_template.md`](_template.md). Prompt files are written just before the
work package starts, so they reflect what already exists in the code.

Foundation (Phase 0) prompts are infrastructure-heavy, so they use a single
**Scope** section instead of user stories, data model and API sections.

## How to use a prompt

Give the agent: "Implement `docs/prompts/<file>` following `CLAUDE.md`.
Work on `main`, commit with sign-off, keep CI green, and update the docs the
prompt names." Review the result against the prompt's acceptance criteria
before starting the next one.

## Phase 0 — Foundation

| Prompt | Depends on |
|---|---|
| [P0.1 Monorepo scaffolding](P0.1-monorepo-scaffolding.md) | — |
| [P0.2 Local environment](P0.2-local-environment.md) | P0.1 |
| [P0.3 API and worker skeletons](P0.3-api-and-worker-skeleton.md) | P0.2 |
| [P0.4 Database foundation](P0.4-database-foundation.md) | P0.3 |
| [P0.5 Core domain](P0.5-core-domain.md) | P0.4 |
| [P0.6 Authentication](P0.6-authentication.md) | P0.5 |
| [P0.7 Authorization and person visibility](P0.7-authorization-and-visibility.md) | P0.6 |
| [P0.8 Seed data](P0.8-seed-data.md) | P0.7 |
| [P0.9 Web shell](P0.9-web-shell.md) | P0.8 |
| [P0.10 Mobile shell and per-account rate limits](P0.10-mobile-shell.md) | P0.9 |
| [P0.11 Backup and restore](P0.11-backup-and-restore.md) | P0.4 (can run in parallel) |
| [P0.12 Entitlements and billing skeleton](P0.12-entitlements-and-billing-skeleton.md) | P0.7 |

After P0.9 the maintainer can log in to the web app as any demo persona and
test the foundation by hand.

## Phase 1 — MVP

| Prompt | Depends on |
|---|---|
| [P1.1 Sign-up, club creation, club managers, joining and invitations](P1.1-signup-clubs-and-joining.md) | P0.12 |
| [P1.2 Member register: search, filter, export](P1.2-member-register.md) | P1.1 |
| [P1.3 Guardians and children: add child, co-guardians, relatives, duplicates, own login, age transitions](P1.3-guardians-and-children.md) | P1.2 |
| [P1.3b Adding members by hand and importing them from a file](P1.3b-add-and-import-members.md) | P1.3 |
| [P1.4 Activities: recurring trainings, matches, locations, in-app calendar](P1.4-activities-and-calendar.md) | P1.3b |
| [P1.5 Responses (attending / not attending) and attendance taking](P1.5-responses-and-attendance.md) | P1.4 |
