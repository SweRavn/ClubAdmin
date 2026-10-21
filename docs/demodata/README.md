# Demo data

The content of the `demo` seed scenario (ADR 0026), loaded by
`apps/api/src/seed/` with `pnpm db:seed` / `pnpm db:reset`.
[`docs/seed-data.md`](../seed-data.md) describes the same people and clubs in
prose and tables; change both together.

| File | Contains |
|---|---|
| `personas.json` | The named people: fixed ID, name, age (birth dates are computed from it), login (`account`, `none` for children, `invited`), email (`.test` only), locale, phone, address, protected identity, who added a child, and the description and tags shown in the `DEV_AUTH` persona picker |
| `clubs.json` | Clubs (founder, founding time, the persona who acts for the club by default) and groups (hierarchy, owners, admission, how many generated members) |
| `relationships.json` | Guardianships, club memberships, roles, group functions, manager hand-overs, own logins, employments, consents, shared fields, join requests, club invitations, platform operators and support grants |
| `waitlists.json` | Waiting-list entries (named or generated applicants, status, queue time, offers) |
| `history.json` | Changes replayed with their past time so the History panel has content |

People, clubs and groups are referred to by key (`anna`, `svk`,
`svk-f2017`). Times are relative to the day of seeding: `now`, `-6y`,
`-14mo`, `-10d`, `+3d`. The files are validated with the Zod schemas in
`packages/shared/src/demodata.ts` when loaded, and every reference is checked;
`pnpm test` loads them.
