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

## Phase 1 — MVP (done, 2026-11-12)

Every Phase 1 prompt is implemented and CI is green on `main`. Prompts from
P1.8b on end with an **"As implemented"** section (what was built, the
deviations and the checks); ADRs record the decisions. P1.10 and P1.15 were
split into parts, each delivered and documented on its own.

| Prompt | Depends on |
|---|---|
| [P1.1 Sign-up, club creation, club managers, joining and invitations](P1.1-signup-clubs-and-joining.md) | P0.12 |
| [P1.2 Member register: search, filter, export](P1.2-member-register.md) | P1.1 |
| [P1.3 Guardians and children: add child, co-guardians, relatives, duplicates, own login, age transitions](P1.3-guardians-and-children.md) | P1.2 |
| [P1.3b Adding members by hand and importing them from a file](P1.3b-add-and-import-members.md) | P1.3 |
| [P1.4 Activities: recurring trainings, matches, locations, in-app calendar](P1.4-activities-and-calendar.md) | P1.3b |
| [P1.5 Responses (attending / not attending) and attendance taking](P1.5-responses-and-attendance.md) | P1.4 |
| [P1.6 Events with sign-up forms, deadlines, capacity and waiting lists](P1.6-events-and-sign-up.md) | P1.5 |
| [P1.6b Clean-up after hands-on testing: forms, groups, places, club settings, answers](P1.6b-cleanup-after-testing.md) | P1.6 |
| [P1.7 Notifications: email, push, in-app; preferences](P1.7-notifications.md) | P1.6b |
| [P1.8a Privacy I: consents, leaving, privacy policy, retention](P1.8a-consents-leaving-retention.md) | P1.7 |
| [P1.8b Privacy II: download my data, account deletion, ward erasure](P1.8b-export-and-erasure.md) | P1.8a |
| [P1.9 Audit log and record-history UI](P1.9-audit-and-history-ui.md) | P1.8b |
| [P1.10a Groups admin: owners, seasons, members, archiving](P1.10a-groups-owners-and-members.md) | P1.9 |
| [P1.10b Waiting lists: applying, offers, admission](P1.10b-waiting-lists.md) | P1.10a |
| [P1.11 Calendar subscriptions with answer links](P1.11-calendar-subscriptions.md) | P1.5 |
| [P1.12 Protected identity UI and profile view log](P1.12-protected-identity-ui.md) | P1.9 |
| [P1.13 Billing: plans, subscriptions, invoices, card payments](P1.13-billing.md) (parts A and B) | P0.12 |
| [P1.14 Review fixes and clean-up before Phase 2](P1.14-review-fixes.md) (findings 1–5; finding 6 moved to P1.15 A4) | P1.13 |
| [P1.15 Club-defined roles and permissions, club types](P1.15-roles-and-permissions.md) (parts A1–A4 and B) | P1.14 |

Findings from the maintainer's review of Phase 1 go into a new review
prompt (like P1.14) before Phase 2 starts.

## Phase 2 — Communication and compliance

| Prompt | Depends on |
|---|---|
| [P2.1 Chat: channels, real time, "Mina kanaler", child safety](P2.1-chat.md) (parts A–C) | P1.15 |
| [P2.2 Announcements: the board, email and push in one message](P2.2-announcements.md) | P1.15 (builds the shared audiences if it comes before P2.4) |
| [P2.3 Car pooling, mileage and a general attestation flow](P2.3-car-pooling-and-attestation.md) | P1.15 |
| [P2.4 Documents I: file archive, audiences, documents attached to notices](P2.4-file-archive.md) | P1.15 |
| [P2.5 Documents II and meetings: governing documents, agendas, minutes, signing](P2.5-governing-documents-and-meetings.md) | P2.4 |
| [P2.6 Volunteer duties](P2.6-volunteer-duties.md) | P2.4 (instructions as documents) |
| [P2.7 Plugins for grant reporting and background checks; LOK and LAM](P2.7-reporting-plugins.md) | P1.15 |
| [P2.8 Background-check plugins for Sweden and Norway; tracking screens](P2.8-background-check-plugins.md) | P2.7, P2.1, P2.6 |

Chat comes first. Each prompt is checked against the code as it is when it
starts (as P1.15 B was) and adjusted before it is implemented; lines marked
**Proposed** are not yet decided by the maintainer and are settled then.
