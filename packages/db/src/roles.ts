// SPDX-License-Identifier: AGPL-3.0-only
export const ROLES = {
  owner: "clubadmin_owner",
  app: "clubadmin_app",
  operator: "clubadmin_operator",
  retention: "clubadmin_retention",
} as const;

export type RoleKey = keyof typeof ROLES;

/** Environment variables holding each role's password (see .env.example). */
export const ROLE_PASSWORD_ENV: Record<RoleKey, string> = {
  owner: "DB_OWNER_PASSWORD",
  app: "DB_APP_PASSWORD",
  operator: "DB_OPERATOR_PASSWORD",
  retention: "DB_RETENTION_PASSWORD",
};
