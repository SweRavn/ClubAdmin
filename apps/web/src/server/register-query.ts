// SPDX-License-Identifier: AGPL-3.0-only
// The member register's search and filters from the page URL (P1.2): only
// values the API accepts are passed on, so a hand-edited URL shows the
// unfiltered list instead of an error; the limited register (board roles)
// keeps only the filters it may use.

import {
  LIMITED_REGISTER_FILTERS,
  type RegisterAccess,
  RegisterQuerySchema,
} from "@clubadmin/shared";

export const REGISTER_PARAMS = [
  "q",
  "status",
  "type",
  "groupId",
  "role",
  "bornFrom",
  "bornTo",
  "gender",
  "missingConsent",
  "sort",
  "order",
] as const;
export type RegisterParam = (typeof REGISTER_PARAMS)[number];

const FILTERS_OF_LIMITED: readonly string[] = [...LIMITED_REGISTER_FILTERS, "sort", "order"];

export function registerParams(
  searchParams: Record<string, string | string[] | undefined>,
  access: RegisterAccess,
): Partial<Record<RegisterParam, string>> {
  const result: Partial<Record<RegisterParam, string>> = {};
  for (const key of REGISTER_PARAMS) {
    const raw = searchParams[key];
    const value = Array.isArray(raw) ? raw.filter(Boolean).join(",") : raw?.trim();
    if (!value) continue;
    if (access === "limited" && !FILTERS_OF_LIMITED.includes(key)) continue;
    if (access === "limited" && key === "sort" && value === "joined") continue;
    if (!RegisterQuerySchema.shape[key].safeParse(value).success) continue;
    result[key] = value;
  }
  return result;
}

export const toQueryString = (params: Partial<Record<string, string>>) =>
  new URLSearchParams(
    Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined),
  ).toString();
