// SPDX-License-Identifier: AGPL-3.0-only
// Application tables (schema `public`), one file per area, re-exported here.
// After changing a schema file run `pnpm db:generate`, then add the
// tenant/history/updated_at helpers to the generated migration (see
// docs/architecture.md, "Database").

export * from "./activities.ts";
export * from "./attendance.ts";
export * from "./clubs.ts";
export * from "./events.ts";
export * from "./groups.ts";
export * from "./joining.ts";
export * from "./members.ts";
export * from "./notifications.ts";
export * from "./people.ts";
export * from "./platform.ts";
