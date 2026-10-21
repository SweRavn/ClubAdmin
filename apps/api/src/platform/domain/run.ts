// SPDX-License-Identifier: AGPL-3.0-only
// Services accept either a club context (club data) or a plain actor context
// (global data such as people); this picks the matching transaction.

import type { ActorContext, Database, TenantContext, Tx } from "@clubadmin/db";
import { type z } from "@clubadmin/shared";

import { DomainError } from "./domain-error.ts";

export type Context = ActorContext | TenantContext;

export const hasClub = (context: Context): context is TenantContext =>
  "clubId" in context && typeof context.clubId === "string";

export function runAs<T>(db: Database, context: Context, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return hasClub(context) ? db.withTenant(context, fn) : db.withActor(context, fn);
}

/** The acting person's ID; domain operations other than sign-up need one. */
export function actorPersonId(context: Context): string {
  if (!context.personId) throw new DomainError("not_allowed");
  return context.personId;
}

/** Parses service input; failures become `invalid_input` without echoing the values. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new DomainError("invalid_input");
  return result.data;
}

/** The object without undefined values (for partial updates under exactOptionalPropertyTypes). */
export function definedOnly<T extends object>(
  value: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
