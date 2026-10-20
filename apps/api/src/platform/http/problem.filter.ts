// SPDX-License-Identifier: AGPL-3.0-only
import { type ArgumentsHost, Catch, type ExceptionFilter } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

import { sendProblem } from "./problem.ts";

/**
 * Every error becomes problem details: errors thrown in controllers, guards and
 * interceptors, and (through Nest's Fastify error handler) errors raised by
 * Fastify and its plugins, such as body parsing and rate limiting.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    sendProblem(exception, http.getRequest<FastifyRequest>(), http.getResponse<FastifyReply>());
  }
}
