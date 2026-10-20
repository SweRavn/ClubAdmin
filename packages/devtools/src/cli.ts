#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Entry point for the pnpm dev:* scripts. Usage: node packages/devtools/src/cli.ts <command>

import { bootstrap, migrate, passwordsFromEnv } from "@clubadmin/db/admin";

import { compose } from "./compose.ts";
import { doctor } from "./doctor.ts";
import { ensureEnvLocal, loadEnv, requireEnv } from "./env.ts";
import { setupGarage } from "./garage.ts";
import { run } from "./process.ts";
import { smoke } from "./smoke.ts";
import { trustCa } from "./trust-ca.ts";

const USAGE = `Usage: pnpm dev[:command]

  dev            start services, then all apps in watch mode
  services       start services only (--full also starts ClamAV)
  down           stop services (data is kept)
  logs [service] follow service logs
  clean          stop services and delete all their data (--yes to skip the question)
  doctor         check this machine and the running services
  trust-ca       trust Caddy's local CA in the OS (--print to only show the commands)
  smoke          check that every service works end to end`;

async function startServices(full: boolean): Promise<boolean> {
  const added = ensureEnvLocal();
  if (added.length > 0) console.log(`.env.local: generated ${added.length} setting(s).`);

  console.log("Starting services (first start downloads images and can take a few minutes)…");
  if (
    (await compose(["up", "--detach", "--wait", "--wait-timeout", "300", "--remove-orphans"], {
      full,
    })) !== 0
  ) {
    console.error("\nServices did not become healthy. Run `pnpm dev:doctor` and `pnpm dev:logs`.");
    return false;
  }

  const env = loadEnv();
  const changes = await setupGarage({
    adminUrl: `http://127.0.0.1:${env.get("GARAGE_ADMIN_PORT") ?? "3903"}`,
    adminToken: requireEnv(env, "GARAGE_ADMIN_TOKEN"),
    accessKeyId: requireEnv(env, "S3_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv(env, "S3_SECRET_ACCESS_KEY"),
    buckets: [requireEnv(env, "S3_BUCKET_FILES"), requireEnv(env, "S3_BUCKET_BACKUPS")],
  });
  for (const change of changes) console.log(`Garage: ${change}`);

  // Database roles, grants and migrations (idempotent).
  await bootstrap({
    adminUrl: requireEnv(env, "DATABASE_ADMIN_URL"),
    passwords: passwordsFromEnv(Object.fromEntries(env)),
  });
  const migrated = await migrate({ ownerUrl: requireEnv(env, "DATABASE_OWNER_URL") });
  console.log(
    migrated.applied.length > 0
      ? `Database: applied ${migrated.applied.join(", ")}`
      : `Database: up to date (${migrated.alreadyApplied} migrations)`,
  );

  const port = env.get("CADDY_HTTPS_PORT") ?? "443";
  const suffix = port === "443" ? "" : `:${port}`;
  console.log(`
Services are up:
  Web app      https://${env.get("APP_DOMAIN")}${suffix}
  Login        https://${env.get("AUTH_DOMAIN")}${suffix}   (admin: ${env.get("ZITADEL_ADMIN_EMAIL")}, password in .env.local)
  Email inbox  http://127.0.0.1:${env.get("MAILPIT_UI_PORT")}
  PostgreSQL   127.0.0.1:${env.get("POSTGRES_PORT")}   Valkey 127.0.0.1:${env.get("VALKEY_PORT")}   S3 ${env.get("S3_ENDPOINT")}
First time? Run \`pnpm dev:trust-ca\` once so browsers trust the HTTPS certificates.
`);
  return true;
}

async function confirm(question: string): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function main(argv: string[]): Promise<number> {
  const [command = "dev", ...rest] = argv;
  const flag = (name: string) => rest.includes(name);

  switch (command) {
    case "dev":
      if (!(await startServices(flag("--full")))) return 1;
      return run("pnpm", ["exec", "turbo", "run", "dev"]);
    case "services":
      return (await startServices(flag("--full"))) ? 0 : 1;
    case "down":
      return compose(["--profile", "full", "down"]);
    case "logs":
      return compose(["logs", "--follow", "--tail", "200", ...rest]);
    case "clean":
      if (
        !flag("--yes") &&
        !(await confirm("Delete all local ClubAdmin service data (databases, files, emails)?"))
      ) {
        return 1;
      }
      return compose(["--profile", "full", "down", "--volumes", "--remove-orphans"]);
    case "doctor":
      return (await doctor()) ? 0 : 1;
    case "trust-ca":
      return (await trustCa(flag("--print"))) ? 0 : 1;
    case "smoke":
      return (await smoke()) ? 0 : 1;
    case "help":
    case "--help":
      console.log(USAGE);
      return 0;
    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
