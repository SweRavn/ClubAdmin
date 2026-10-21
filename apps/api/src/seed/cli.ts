// SPDX-License-Identifier: AGPL-3.0-only
// pnpm db:seed [--scenario demo|minimal|load] [--size n] [--if-empty]
// pnpm db:reset [--scenario ...]: drop and recreate the development
// database, bootstrap roles, migrate, then seed.
// Both refuse to run in production or on the hosted service (guard.ts).

/* eslint-disable no-console -- a command-line tool; prints no personal data */

import { createDatabase } from "@clubadmin/db";
import {
  type AdminQuery,
  bootstrap,
  migrate,
  passwordsFromEnv,
  recreateDatabase,
  withAdminConnection,
} from "@clubadmin/db/admin";
import { loadEnvFiles } from "@clubadmin/server-kit";

import { createCoreServices } from "../domain-services.ts";
import { FieldEncryption } from "../platform/crypto/field-encryption.ts";
import { resetRefusal, seedRefusal } from "./guard.ts";
import { type Scenario, SCENARIOS, seed } from "./runner.ts";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
}

function parseArgs(argv: string[]): { scenario: Scenario; size?: number; ifEmpty: boolean } {
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const scenario = (value("--scenario") ?? "demo") as Scenario;
  if (!SCENARIOS.includes(scenario)) throw new Error(`unknown scenario ${scenario}`);
  const size = value("--size");
  return {
    scenario,
    ...(size ? { size: Number(size) } : {}),
    ifEmpty: argv.includes("--if-empty"),
  };
}

/** Superuser SQL on the target database. */
const asAdmin = <T>(fn: (query: AdminQuery) => Promise<T>): Promise<T> =>
  withAdminConnection(requireEnv("DATABASE_ADMIN_URL"), fn);

async function reset(): Promise<void> {
  const adminUrl = requireEnv("DATABASE_ADMIN_URL");
  await recreateDatabase(adminUrl);
  await bootstrap({ adminUrl, passwords: passwordsFromEnv() });
  await migrate({ ownerUrl: requireEnv("DATABASE_OWNER_URL"), log: (m) => console.log(m) });
}

async function main(command: string | undefined, argv: string[]): Promise<number> {
  loadEnvFiles();
  if (command !== "seed" && command !== "reset") {
    console.error(
      "Usage: cli.js seed|reset [--scenario demo|minimal|load] [--size n] [--if-empty]",
    );
    return 1;
  }
  const args = parseArgs(argv);
  const refusal =
    command === "reset"
      ? resetRefusal(process.env, requireEnv("DATABASE_ADMIN_URL"))
      : seedRefusal(process.env);
  if (refusal) {
    console.error(refusal);
    return 1;
  }
  const started = performance.now();
  if (command === "reset") await reset();

  const existing = await asAdmin(async (query) => {
    // Seed mode: replayed changes get their past times in history (ADR 0026).
    await query("INSERT INTO app_meta.seed_mode DEFAULT VALUES ON CONFLICT DO NOTHING");
    const { rows } = await query<{ n: number }>("SELECT count(*)::int AS n FROM clubs");
    return rows[0]!.n;
  });
  if (existing > 0) {
    if (args.ifEmpty) {
      console.log("The database already has data; not seeding.");
      return 0;
    }
    console.error("The database is not empty; use pnpm db:reset to start over.");
    return 1;
  }

  const db = createDatabase({
    url: requireEnv("DATABASE_URL"),
    max: 4,
    applicationName: "clubadmin-seed",
  });
  try {
    await seed(
      {
        db,
        services: createCoreServices(db, { encryption: FieldEncryption.fromConfig(process.env) }),
        addPlatformOperator: (personId) =>
          asAdmin(async (query) => {
            await query("BEGIN");
            await query(
              "SELECT set_config('app.actor_kind', 'operator', true), set_config('app.person_id', $1, true), set_config('app.request_id', 'seed:demo', true)",
              [personId],
            );
            await query("INSERT INTO platform_operators (person_id) VALUES ($1)", [personId]);
            await query("COMMIT");
          }),
        admin: (sql) => asAdmin(async (query) => void (await query(sql))),
      },
      { ...args, log: (m) => console.log(m) },
    );
  } finally {
    await db.close();
  }
  console.log(`Seeded ${args.scenario} in ${((performance.now() - started) / 1000).toFixed(1)} s.`);
  return 0;
}

try {
  process.exitCode = await main(process.argv[2], process.argv.slice(3));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
