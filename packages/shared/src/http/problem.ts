// SPDX-License-Identifier: AGPL-3.0-only
// RFC 9457 problem details, the only error format of the API.
// Problem types are documented in docs/api/problems.md.

import { z } from "../zod.ts";

export const PROBLEM_TYPE_BASE =
  "https://github.com/SweRavn/ClubAdmin/blob/main/docs/api/problems.md";

/** Known problem types: slug → HTTP status. Titles are translated (message key `problem.<slug>`). */
export const PROBLEM_TYPES = {
  "bad-request": 400,
  validation: 400,
  unauthenticated: 401,
  forbidden: 403,
  "mfa-required": 403,
  "reauthentication-required": 403,
  "not-found": 404,
  "method-not-allowed": 405,
  conflict: 409,
  "payload-too-large": 413,
  "unsupported-media-type": 415,
  "rate-limited": 429,
  internal: 500,
  "not-implemented": 501,
  unavailable: 503,
  // Specific types after the generic ones (problemSlugForStatus takes the first match).
  /** The club's plan does not include the feature (billing on). */
  "entitlement-required": 402,
  /** The club is read-only (for example unpaid): reads and exports still work. */
  "club-read-only": 409,
  /** An operator suspended the club: only exports work. */
  "club-suspended": 409,
} as const;

export type ProblemSlug = keyof typeof PROBLEM_TYPES;

export const problemTypeUri = (slug: ProblemSlug) => `${PROBLEM_TYPE_BASE}#${slug}`;

/** Maps an HTTP status to the generic problem type for it. */
export function problemSlugForStatus(status: number): ProblemSlug {
  const match = (Object.entries(PROBLEM_TYPES) as [ProblemSlug, number][]).find(
    ([slug, code]) => code === status && slug !== "validation",
  );
  if (match) return match[0];
  return status >= 500 ? "internal" : "bad-request";
}

export const ValidationIssueSchema = z
  .object({
    location: z.enum(["body", "query", "params", "headers"]),
    path: z.string().openapi({ example: "groups[0].name" }),
    code: z.string().openapi({ example: "too_small" }),
    message: z.string(),
  })
  .openapi("ValidationIssue");

export const ProblemDetailsSchema = z
  .object({
    type: z.string().openapi({ example: problemTypeUri("validation") }),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().optional(),
    instance: z.string().optional(),
    requestId: z.string(),
    errors: z.array(ValidationIssueSchema).optional(),
  })
  .openapi("ProblemDetails");

export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;

export const PROBLEM_CONTENT_TYPE = "application/problem+json";
