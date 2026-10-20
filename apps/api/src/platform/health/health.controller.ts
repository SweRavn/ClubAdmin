// SPDX-License-Identifier: AGPL-3.0-only
// Liveness and readiness for orchestrators and the reverse proxy. Not under
// /api/v1 and not rate limited. Readiness answers 503 when a dependency fails.

import { type HealthResponse, HealthResponseSchema } from "@clubadmin/shared";
import { Controller, Inject, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";

import { Endpoint } from "../http/endpoint.ts";
import { DATABASE, type OptionalDatabase } from "../infra/database.ts";
import { VALKEY_CLIENT, type ValkeyClient } from "../infra/valkey.ts";

type Check = NonNullable<HealthResponse["checks"]>[string];

async function timed(run: () => Promise<unknown>, timeoutMs = 2_000): Promise<Check> {
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      run(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
    return { status: "ok", durationMs: Math.round(performance.now() - started) };
  } catch (error) {
    return {
      status: "fail",
      durationMs: Math.round(performance.now() - started),
      detail: error instanceof Error ? error.message : "failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

const skipped = (detail: string): Check => ({ status: "skipped", durationMs: 0, detail });

/** Fails when this version's migrations are not all applied (or an applied one was edited). */
async function checkMigrations(db: NonNullable<OptionalDatabase>): Promise<void> {
  const status = await db.migrationStatus();
  if (status.pending.length > 0)
    throw new Error(`pending migrations: ${status.pending.join(", ")}`);
  if (status.changed.length > 0)
    throw new Error(`changed migrations: ${status.changed.join(", ")}`);
}

@Controller("health")
export class HealthController {
  private readonly db: OptionalDatabase;
  private readonly valkey: ValkeyClient;

  constructor(@Inject(DATABASE) db: OptionalDatabase, @Inject(VALKEY_CLIENT) valkey: ValkeyClient) {
    this.db = db;
    this.valkey = valkey;
  }

  @Endpoint({
    method: "GET",
    path: "live",
    summary: "Liveness: the process is up",
    tags: ["health"],
    access: { public: true },
    response: HealthResponseSchema,
  })
  live(): HealthResponse {
    return { status: "ok" };
  }

  @Endpoint({
    method: "GET",
    path: "ready",
    summary: "Readiness: dependencies are reachable (503 otherwise)",
    tags: ["health"],
    access: { public: true },
    response: HealthResponseSchema,
  })
  async ready(@Res({ passthrough: true }) reply: FastifyReply): Promise<HealthResponse> {
    const db = this.db;
    const valkey = this.valkey;
    const [database, cache, migrations] = await Promise.all([
      db ? timed(() => db.ping()) : Promise.resolve(skipped("DATABASE_URL not set")),
      valkey ? timed(() => valkey.ping()) : Promise.resolve(skipped("VALKEY_URL not set")),
      db ? timed(() => checkMigrations(db)) : Promise.resolve(skipped("DATABASE_URL not set")),
    ]);
    const checks = { database, valkey: cache, migrations };
    const failed = Object.values(checks).some((c) => c.status === "fail");
    if (failed) void reply.status(503);
    return { status: failed ? "fail" : "ok", checks };
  }
}
