#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Entry point for the pnpm dev:* scripts. Usage: node packages/devtools/src/cli.ts <command>

import { existsSync, readFileSync } from "node:fs";

import { bootstrap, migrate, passwordsFromEnv } from "@clubadmin/db/admin";

import { exportCaddyRootCert } from "./caddy.ts";
import { compose } from "./compose.ts";
import { doctor } from "./doctor.ts";
import { ensureEnvLocal, loadEnv, requireEnv, setEnvValues } from "./env.ts";
import { setupGarage } from "./garage.ts";
import { fetchWithCa } from "./https.ts";
import { caddyRootCertFile } from "./paths.ts";
import { run } from "./process.ts";
import { smoke } from "./smoke.ts";
import { trustCa } from "./trust-ca.ts";
import { configureZitadel } from "./zitadel.ts";
import { readZitadelAdminPat } from "./zitadel-pat.ts";

const USAGE = `Usage: pnpm dev[:command]

  dev            start services, then all apps in watch mode
  services       start services only (--full also starts ClamAV)
  down           stop services (data is kept)
  logs [service] follow service logs
  clean          stop services and delete all their data (--yes to skip the question)
  doctor         check this machine and the running services
  trust-ca       trust Caddy's local CA in the OS (--print to only show the commands)
  smoke          check that every service works end to end
  auth-configure apply infra/zitadel/ to Zitadel (also run by services); --print only prints the results`;

/** Caddy's CA from the running container, or the copy exported earlier. */
function localCa(): string {
  try {
    return exportCaddyRootCert();
  } catch (error) {
    if (existsSync(caddyRootCertFile)) return readFileSync(caddyRootCertFile, "utf8");
    throw error;
  }
}

/**
 * Applies the Zitadel configuration as code (idempotent). In development the
 * token comes from the bootstrap volume and the results go to .env.local;
 * operators pass ZITADEL_URL and ZITADEL_PAT and use --print.
 */
async function authConfigure(print: boolean): Promise<boolean> {
  const env = loadEnv();
  for (const [key, value] of Object.entries(process.env)) if (value) env.set(key, value);
  const baseUrl = env.get("ZITADEL_URL") ?? requireEnv(env, "AUTH_ISSUER");
  const token = env.get("ZITADEL_PAT") ?? readZitadelAdminPat();
  const local = new URL(baseUrl).hostname.endsWith(".localhost");
  const { changes, outputs } = await configureZitadel({
    baseUrl,
    token,
    variables: env,
    userSignup: env.get("USER_SIGNUP") === "invite_only" ? "invite_only" : "open",
    existing: {
      webClientId: env.get("AUTH_WEB_CLIENT_ID"),
      webClientSecret: env.get("AUTH_WEB_CLIENT_SECRET"),
      apiToken: env.get("ZITADEL_API_TOKEN"),
    },
    log: (message) => console.log(`Zitadel: ${message}`),
    // Development: Caddy's local CA, connecting to 127.0.0.1 for *.localhost.
    ...(local ? { fetch: fetchWithCa(localCa()) } : {}),
  });
  if (print) {
    for (const [key, value] of Object.entries(outputs)) console.log(`${key}=${value}`);
    return true;
  }
  const written = setEnvValues({ AUTH_AUDIENCE: outputs.AUTH_PROJECT_ID, ...outputs });
  console.log(
    changes.length === 0 && written.length === 0
      ? "Zitadel: up to date"
      : `Zitadel: configured${written.length > 0 ? ` (.env.local: ${written.join(", ")})` : ""}`,
  );
  return true;
}

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

  await authConfigure(false);

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
      // Settings Node.js reads only at process start (Caddy's CA for https://auth.clubadmin.localhost).
      return run("pnpm", ["exec", "turbo", "run", "dev"], {
        ...process.env,
        NODE_EXTRA_CA_CERTS: loadEnv().get("NODE_EXTRA_CA_CERTS") ?? "",
        NEXT_TELEMETRY_DISABLED: "1",
      });
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
    case "auth-configure":
      return (await authConfigure(flag("--print"))) ? 0 : 1;
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
