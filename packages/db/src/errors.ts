// SPDX-License-Identifier: AGPL-3.0-only
// Recognising constraint violations, so services can turn them into domain
// errors. Works on errors seen inside a transaction (wrapped by Drizzle) and
// after it (unwrapped by withTenant/withActor/withSystem).

import { unwrapQueryError } from "./database.ts";

export interface DatabaseErrorInfo {
  /** SQLSTATE, e.g. 23505 (unique violation). */
  code: string;
  constraint: string | undefined;
}

export function databaseError(error: unknown): DatabaseErrorInfo | null {
  const cause = unwrapQueryError(error);
  if (typeof cause !== "object" || cause === null) return null;
  const { code, constraint } = cause as { code?: unknown; constraint?: unknown };
  if (typeof code !== "string" || !/^[0-9A-Z]{5}$/.test(code)) return null;
  return { code, constraint: typeof constraint === "string" ? constraint : undefined };
}

const matches = (error: unknown, code: string, constraint?: string): boolean => {
  const info = databaseError(error);
  return (
    info !== null &&
    info.code === code &&
    (constraint === undefined || info.constraint === constraint)
  );
};

export const isUniqueViolation = (error: unknown, constraint?: string) =>
  matches(error, "23505", constraint);
export const isCheckViolation = (error: unknown, constraint?: string) =>
  matches(error, "23514", constraint);
export const isForeignKeyViolation = (error: unknown, constraint?: string) =>
  matches(error, "23503", constraint);
/** Row-level security refused a write (42501, "new row violates row-level security policy"). */
export const isRlsViolation = (error: unknown) => matches(error, "42501");
