// SPDX-License-Identifier: AGPL-3.0-only
// Helpers for tests: an app with captured logs and a test-only controller.

import { Writable } from "node:stream";

import { createLogger } from "@clubadmin/server-kit";
import { z } from "@clubadmin/shared";
import { Body, Controller, Module } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";

import { createApp } from "../app.ts";
import { loadApiConfig } from "../config.ts";
import { Endpoint } from "../platform/http/endpoint.ts";
import { ProblemError } from "../platform/http/problem-error.ts";

const EchoBody = z.object({ email: z.email(), count: z.number().int().min(1) });

@Controller("test")
export class TestController {
  @Endpoint({
    method: "POST",
    path: "echo",
    summary: "Echo",
    access: { public: true },
    request: { body: EchoBody },
    response: z.object({ count: z.number() }),
    status: 200,
  })
  echo(@Body() body: z.infer<typeof EchoBody>): { count: number; secret: string } {
    // `secret` is not in the response schema and must be stripped.
    return { count: body.count, secret: "must-not-leak" };
  }

  @Endpoint({
    method: "GET",
    path: "crash",
    summary: "Crash",
    access: { public: true },
    response: z.object({}),
  })
  crash(): never {
    throw new Error("database password is hunter2 at /srv/app.ts:12");
  }

  @Endpoint({
    method: "GET",
    path: "conflict",
    summary: "Conflict",
    access: { public: true },
    response: z.object({}),
  })
  conflict(): never {
    throw new ProblemError("conflict", { detail: "The group was changed by someone else." });
  }

  @Endpoint({
    method: "GET",
    path: "limited",
    summary: "Limited",
    access: { public: true },
    response: z.object({ ok: z.boolean() }),
    rateLimit: { max: 2, timeWindowMs: 60_000 },
  })
  limited(): { ok: boolean } {
    return { ok: true };
  }
}

@Module({ controllers: [TestController] })
export class TestModule {}

export interface TestApp {
  app: NestFastifyApplication;
  logs: Record<string, unknown>[];
  rawLogs: () => string;
  close: () => Promise<void>;
}

export async function createTestApp(
  env: NodeJS.ProcessEnv = {},
  modules: NonNullable<Parameters<typeof createApp>[1]>["modules"] = [TestModule],
): Promise<TestApp> {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const config = loadApiConfig({ NODE_ENV: "test", LOG_LEVEL: "debug", ...env });
  const logger = createLogger({ service: "clubadmin-api", level: "debug", destination });
  const app = await createApp(config, { logger, modules });
  await app.getHttpAdapter().getInstance().ready();
  const rawLogs = () => chunks.join("");
  return {
    app,
    rawLogs,
    get logs() {
      return rawLogs()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    close: () => app.close(),
  };
}
