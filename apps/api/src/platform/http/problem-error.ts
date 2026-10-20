// SPDX-License-Identifier: AGPL-3.0-only
import { PROBLEM_TYPES, type ProblemSlug, type ValidationIssue } from "@clubadmin/shared";

/** Throw this from application code to answer with a specific problem type. */
export class ProblemError extends Error {
  readonly slug: ProblemSlug;
  readonly status: number;
  /** Shown to the client. Must not contain personal data. */
  readonly detail: string | undefined;
  readonly errors: ValidationIssue[] | undefined;

  constructor(
    slug: ProblemSlug,
    options: { detail?: string; errors?: ValidationIssue[]; cause?: unknown } = {},
  ) {
    super(options.detail ?? slug, { cause: options.cause });
    this.name = "ProblemError";
    this.slug = slug;
    this.status = PROBLEM_TYPES[slug];
    this.detail = options.detail;
    this.errors = options.errors;
  }
}
