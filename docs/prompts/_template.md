# <ID> — <Title>

## Context
Read first: `CLAUDE.md`, <relevant docs/ADRs>.
What exists already: <modules, tables, endpoints this builds on>.

## Goal
<One paragraph: what the user can do when this is done, and why.>

## Users and roles involved
<Which roles from `domain-model.md` interact with this feature.>

## User stories
- As a <role>, I want <capability>, so that <benefit>.

## Data model
<New tables/columns, with `club_id`, RLS policy, indexes, retention.>

## API
| Method | Path | Permission | Notes |
|---|---|---|---|

## Permissions
<Policies to add, with the allow and deny cases that must be tested.>

## UI
<Web screens (and mobile, if in scope). Loading states, empty states, errors.>

## Privacy and security
<Personal data touched, legal basis, consent, who may see which fields,
audit events, retention, child-safety concerns.>

## Protected identity
<Where this feature shows people; confirm all of it goes through
`PersonVisibility`; what protected persons see and what others see.>

## Locale and country packs
<Translations needed (sv, en, nb); country-specific rules and where they live.>

## Performance
<Expected data volumes, hot queries and their indexes, budgets from
`performance.md` that apply.>

## Seed data
<What to add to the demo scenario so the feature can be tried immediately
with the personas in `seed-data.md`.>

## Acceptance criteria
- [ ] ...
- [ ] Tenant-isolation test for every new endpoint
- [ ] Allow/deny tests for every new policy
- [ ] Audit events for every change to personal data
- [ ] Translations complete for sv and en
- [ ] Docs updated (`domain-model.md`, ADRs if decisions changed)

## Out of scope
- ...
