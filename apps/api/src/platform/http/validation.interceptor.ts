// SPDX-License-Identifier: AGPL-3.0-only
// Validates params, query and body against the @Endpoint schemas before the
// handler runs (replacing them with the parsed values), and the handler's
// result against the response schema (stripping unknown fields, so nothing
// the schema does not declare can leak).

import type { ValidationIssue, z } from "@clubadmin/shared";
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";
import { map, type Observable } from "rxjs";

import { ENDPOINT_METADATA, type EndpointOptions } from "./endpoint.ts";
import { ProblemError } from "./problem-error.ts";

type Location = ValidationIssue["location"];

function toIssues(location: Location, error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    location,
    path: issue.path
      .map((segment, i) =>
        typeof segment === "number" ? `[${segment}]` : `${i === 0 ? "" : "."}${String(segment)}`,
      )
      .join(""),
    code: issue.code,
    // Zod messages describe the expected shape, never the received value.
    message: issue.message,
  }));
}

@Injectable()
export class ValidationInterceptor implements NestInterceptor {
  private readonly reflector: Reflector;

  constructor(reflector: Reflector) {
    this.reflector = reflector;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const endpoint = this.reflector.get<EndpointOptions | undefined>(
      ENDPOINT_METADATA,
      context.getHandler(),
    );
    if (!endpoint) return next.handle();

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const issues: ValidationIssue[] = [];
    const parts: [Location, z.ZodType | undefined, "params" | "query" | "body"][] = [
      ["params", endpoint.request?.params, "params"],
      ["query", endpoint.request?.query, "query"],
      ["body", endpoint.request?.body, "body"],
    ];
    for (const [location, schema, key] of parts) {
      if (!schema) continue;
      const result = schema.safeParse(request[key] ?? (key === "body" ? undefined : {}));
      if (result.success) {
        (request as unknown as Record<string, unknown>)[key] = result.data;
      } else {
        issues.push(...toIssues(location, result.error));
      }
    }
    if (issues.length > 0) throw new ProblemError("validation", { errors: issues });

    return next.handle().pipe(
      map((output: unknown) => {
        const result = endpoint.response.safeParse(output);
        if (!result.success) {
          // A bug in our code: the handler returned something its schema does not allow.
          throw new Error(
            `Response of ${endpoint.method} ${endpoint.path} does not match its schema: ` +
              result.error.issues.map((i) => `${i.path.join(".")} ${i.code}`).join(", "),
          );
        }
        return result.data;
      }),
    );
  }
}
