// SPDX-License-Identifier: AGPL-3.0-only
// Converts any error into an RFC 9457 problem-details response (used by
// ProblemDetailsFilter).

import { negotiateLocale, translate } from "@clubadmin/i18n";
import {
  PROBLEM_CONTENT_TYPE,
  type ProblemDetails,
  type ProblemSlug,
  problemSlugForStatus,
  problemTypeUri,
} from "@clubadmin/shared";
import { HttpException } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

import { ProblemError } from "./problem-error.ts";

interface ResolvedProblem {
  slug: ProblemSlug;
  status: number;
  detail?: string | undefined;
  errors?: ProblemDetails["errors"];
  /** True for errors we did not anticipate (logged as errors). */
  unexpected: boolean;
}

const FASTIFY_CODES: Record<string, ProblemSlug> = {
  FST_ERR_CTP_BODY_TOO_LARGE: "payload-too-large",
  FST_ERR_CTP_INVALID_MEDIA_TYPE: "unsupported-media-type",
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: "bad-request",
  FST_ERR_CTP_EMPTY_JSON_BODY: "bad-request",
  FST_ERR_CTP_INVALID_JSON_BODY: "bad-request",
};

export function resolveProblem(error: unknown): ResolvedProblem {
  if (error instanceof ProblemError) {
    return {
      slug: error.slug,
      status: error.status,
      detail: error.detail,
      errors: error.errors,
      unexpected: false,
    };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    return { slug: problemSlugForStatus(status), status, unexpected: status >= 500 };
  }
  if (typeof error === "object" && error !== null) {
    const { code, statusCode } = error as { code?: unknown; statusCode?: unknown };
    if (typeof code === "string" && code in FASTIFY_CODES) {
      const slug = FASTIFY_CODES[code] ?? "bad-request";
      return {
        slug,
        status: slug === "payload-too-large" ? 413 : slug === "unsupported-media-type" ? 415 : 400,
        unexpected: false,
      };
    }
    if (code === "FST_ERR_NOT_FOUND") return { slug: "not-found", status: 404, unexpected: false };
    // JSON syntax errors from the body parser carry statusCode 400.
    if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
      return { slug: problemSlugForStatus(statusCode), status: statusCode, unexpected: false };
    }
  }
  return { slug: "internal", status: 500, unexpected: true };
}

export function buildProblem(resolved: ResolvedProblem, request: FastifyRequest): ProblemDetails {
  const locale = negotiateLocale(request.headers["accept-language"]);
  const problem: ProblemDetails = {
    type: problemTypeUri(resolved.slug),
    title: translate(locale, `problem.${resolved.slug}`),
    status: resolved.status,
    instance: request.url.split("?")[0],
    requestId: request.id,
  };
  if (resolved.detail !== undefined) problem.detail = resolved.detail;
  if (resolved.errors !== undefined) problem.errors = resolved.errors;
  return problem;
}

/** Logs the error (redacted, without request data) and sends the problem response. */
export function sendProblem(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  const resolved = resolveProblem(error);
  if (resolved.unexpected) {
    request.log.error({ err: error, requestId: request.id }, "unhandled error");
  } else {
    request.log.debug({ problem: resolved.slug, status: resolved.status }, "request failed");
  }
  if (
    resolved.status === 429 &&
    typeof (error as { retryAfter?: unknown }).retryAfter === "number"
  ) {
    void reply.header("retry-after", String((error as { retryAfter: number }).retryAfter));
  }
  return reply
    .status(resolved.status)
    .type(PROBLEM_CONTENT_TYPE)
    .send(buildProblem(resolved, request));
}
