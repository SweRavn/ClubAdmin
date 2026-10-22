// SPDX-License-Identifier: AGPL-3.0-only
// Creates the Nest application on Fastify with all cross-cutting HTTP
// behaviour. Used by main.ts, the tests and the OpenAPI script.

import "reflect-metadata";

import type { IncomingMessage } from "node:http";

import { createLogger, type Logger } from "@clubadmin/server-kit";
import { DEV_AUTH_WARNING, isUuid, uuidv7 } from "@clubadmin/shared";
import fastifyCors from "@fastify/cors";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
import type { DynamicModule, Type } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { type FastifyReply, type FastifyRequest, LogController } from "fastify";

import { AppModule } from "./app.module.ts";
import type { ApiConfig } from "./config.ts";
import { API_PREFIX, UNPREFIXED_PATHS } from "./platform/http/prefix.ts";
import { VALKEY_CLIENT, type ValkeyClient } from "./platform/infra/valkey.ts";
import { NestPinoLogger } from "./platform/logging/nest-logger.ts";

export interface CreateAppOptions {
  logger?: Logger;
  /** Extra modules, used by tests to add routes. */
  modules?: (Type | DynamicModule)[];
}

const REQUEST_ID_HEADER = "x-request-id";

const hasBearer = (request: FastifyRequest) =>
  /^Bearer\s+\S/i.test(request.headers.authorization ?? "");

/** Accept the proxy's request ID only if it is a UUID; otherwise make a new one. */
export function requestIdFrom(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  return value !== undefined && isUuid(value) ? value.toLowerCase() : uuidv7();
}

export async function createApp(
  config: ApiConfig,
  options: CreateAppOptions = {},
): Promise<NestFastifyApplication> {
  const logger =
    options.logger ?? createLogger({ service: "clubadmin-api", level: config.LOG_LEVEL });

  if (config.DEV_AUTH) logger.warn(DEV_AUTH_WARNING);

  const adapter = new FastifyAdapter({
    loggerInstance: logger,
    // Requests are logged once, in onResponse below, without query strings or bodies.
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: "requestId",
    }),
    genReqId: (request: IncomingMessage) => requestIdFrom(request.headers[REQUEST_ID_HEADER]),
    bodyLimit: config.BODY_LIMIT_BYTES,
    requestTimeout: config.REQUEST_TIMEOUT_MS,
    connectionTimeout: config.REQUEST_TIMEOUT_MS,
    trustProxy: config.TRUST_PROXY,
    return503OnClosing: true,
  });

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(config, options.modules),
    adapter,
    { logger: new NestPinoLogger(logger), bufferLogs: false, abortOnError: false },
  );
  app.setGlobalPrefix(API_PREFIX, {
    exclude: UNPREFIXED_PATHS.map((p) => `${p.slice(1)}/{*path}`),
  });
  app.enableShutdownHooks();

  const fastify = app.getHttpAdapter().getInstance();

  fastify.addHook("onSend", async (request: FastifyRequest, reply: FastifyReply) => {
    void reply.header(REQUEST_ID_HEADER, request.id);
  });
  fastify.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply) => {
    request.log.info(
      {
        method: request.method,
        // The route template (/api/v1/groups/:groupId), never the raw URL with query string.
        route: request.routeOptions.url ?? "unmatched",
        status: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      "request",
    );
  });

  await app.register(fastifyHelmet, {
    // JSON API: nothing may be framed or loaded.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
    crossOriginResourcePolicy: { policy: "same-site" },
    referrerPolicy: { policy: "no-referrer" },
  });
  await app.register(fastifyCors, {
    origin: config.CORS_ORIGINS,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    exposedHeaders: [REQUEST_ID_HEADER, "retry-after"],
    maxAge: 600,
  });
  const valkey = app.get<ValkeyClient>(VALKEY_CLIENT);
  await app.register(fastifyRateLimit, {
    global: true,
    // Per client IP. Requests with a bearer token get the much higher backstop
    // and their own counter: they are limited per account by the AuthGuard,
    // which also counts rejected tokens against the unauthenticated limit.
    max: (request) => (hasBearer(request) ? config.RATE_LIMIT_IP_BACKSTOP : config.RATE_LIMIT_MAX),
    keyGenerator: (request) => `${hasBearer(request) ? "auth" : "anon"}:${request.ip}`,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    // Shared across API instances via Valkey; in-memory when Valkey is not configured.
    ...(valkey ? { redis: valkey, nameSpace: `${config.RATE_LIMIT_NAMESPACE}:rate-limit:` } : {}),
    // If Valkey is unreachable, serve the request rather than failing it.
    skipOnError: true,
    allowList: (request) => request.url.startsWith("/health/"),
    errorResponseBuilder: (_request, context) =>
      Object.assign(new Error("rate limited"), {
        statusCode: 429,
        retryAfter: Math.ceil(context.ttl / 1000),
      }),
  });

  await app.init();
  return app;
}
