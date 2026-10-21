// SPDX-License-Identifier: AGPL-3.0-only
// Administrative entry point (@clubadmin/db/admin): bootstrap and migrations,
// for the CLI and dev tooling. Not for application code.
export { bootstrap, passwordsFromEnv } from "./bootstrap.ts";
export { type AdminQuery, recreateDatabase, withAdminConnection } from "./dev-admin.ts";
export { migrate, type MigrateResult } from "./migrate.ts";
export { ROLE_PASSWORD_ENV, ROLES } from "./roles.ts";
