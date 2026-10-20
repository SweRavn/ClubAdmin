// SPDX-License-Identifier: AGPL-3.0-only
// Generates and maintains .env.local for local development. Secrets are random
// per installation and never committed. See docs/development.md.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { caddyRootCertFile, envFile, envLocalFile } from "./paths.ts";

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const alphanumeric = (length: number) => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = randomBytes(length);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
};

export interface EnvVariable {
  key: string;
  /** Fixed default or a generator for secrets. */
  value: string | (() => string);
  comment?: string;
}

export interface EnvSection {
  title: string;
  variables: EnvVariable[];
}

/**
 * Everything `pnpm dev` needs. New keys added here are appended to an existing
 * .env.local automatically; existing values are never changed.
 * .env.example must list every key (checked by a test).
 */
export const ENV_TEMPLATE: EnvSection[] = [
  {
    title: "Application flags (docs/hosting-and-billing.md)",
    variables: [
      { key: "NODE_ENV", value: "development" },
      { key: "DEPLOYMENT_MODE", value: "self_hosted" },
      { key: "BILLING_ENABLED", value: "false" },
      { key: "USER_SIGNUP", value: "open" },
      { key: "CLUB_CREATION", value: "open" },
      { key: "DEFAULT_COUNTRY", value: "SE" },
      { key: "DEV_AUTH", value: "true" },
    ],
  },
  {
    title: "Public URLs (served by Caddy with a local CA, see pnpm dev:trust-ca)",
    variables: [
      { key: "APP_DOMAIN", value: "clubadmin.localhost" },
      { key: "AUTH_DOMAIN", value: "auth.clubadmin.localhost" },
      { key: "CADDY_HTTP_PORT", value: "80" },
      { key: "CADDY_HTTPS_PORT", value: "443" },
      { key: "PUBLIC_WEB_URL", value: "https://clubadmin.localhost" },
      { key: "AUTH_ISSUER", value: "https://auth.clubadmin.localhost" },
      { key: "WEB_PORT", value: "3000" },
      { key: "API_PORT", value: "4000" },
      {
        key: "NODE_EXTRA_CA_CERTS",
        value: () => caddyRootCertFile,
        comment: "Lets Node.js trust Caddy's local CA (written by pnpm dev:trust-ca)",
      },
    ],
  },
  {
    title: "API and worker",
    variables: [
      { key: "LOG_LEVEL", value: "debug" },
      {
        key: "API_HOST",
        value: "0.0.0.0",
        comment: "Caddy runs in Docker and reaches the API on the host through the Docker gateway",
      },
      { key: "CORS_ORIGINS", value: "${PUBLIC_WEB_URL}" },
      { key: "SOURCE_URL", value: "https://github.com/SweRavn/ClubAdmin" },
      { key: "OPENAPI_ENABLED", value: "true" },
      { key: "WORKER_CONCURRENCY", value: "5" },
      {
        key: "OTEL_EXPORTER_OTLP_ENDPOINT",
        value: "",
        comment:
          "Set (e.g. http://127.0.0.1:4318) to send traces and metrics to an OpenTelemetry collector",
      },
    ],
  },
  {
    title: "PostgreSQL",
    variables: [
      { key: "POSTGRES_USER", value: "postgres" },
      { key: "POSTGRES_PASSWORD", value: () => alphanumeric(32) },
      { key: "POSTGRES_DB", value: "clubadmin" },
      { key: "POSTGRES_PORT", value: "5432" },
      {
        key: "DATABASE_ADMIN_URL",
        value: () =>
          "postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_PORT}/${POSTGRES_DB}",
        comment: "Superuser connection for bootstrap/migrations; app roles come in P0.4",
      },
      {
        key: "DATABASE_URL",
        value: "${DATABASE_ADMIN_URL}",
        comment: "Used by the API and worker; switches to the unprivileged app role in P0.4",
      },
      { key: "ZITADEL_DB_USER", value: "zitadel" },
      { key: "ZITADEL_DB_PASSWORD", value: () => alphanumeric(32) },
    ],
  },
  {
    title: "Valkey",
    variables: [
      { key: "VALKEY_PORT", value: "6379" },
      { key: "VALKEY_URL", value: "redis://127.0.0.1:6379" },
    ],
  },
  {
    title: "Zitadel (identity provider)",
    variables: [
      { key: "ZITADEL_MASTERKEY", value: () => alphanumeric(32), comment: "Exactly 32 characters" },
      { key: "ZITADEL_ADMIN_EMAIL", value: "admin@clubadmin.test" },
      { key: "ZITADEL_ADMIN_PASSWORD", value: () => `Dev-${alphanumeric(20)}-1!` },
      { key: "ZITADEL_LOGIN_COOKIE_SECRET", value: () => randomBytes(32).toString("base64") },
    ],
  },
  {
    title: "Object storage (Garage, S3 API)",
    variables: [
      { key: "S3_PORT", value: "3900" },
      { key: "S3_ENDPOINT", value: "http://127.0.0.1:3900" },
      { key: "S3_REGION", value: "garage" },
      { key: "S3_BUCKET_FILES", value: "clubadmin-files" },
      { key: "S3_BUCKET_BACKUPS", value: "clubadmin-backups" },
      { key: "S3_ACCESS_KEY_ID", value: () => `GK${hex(12)}` },
      { key: "S3_SECRET_ACCESS_KEY", value: () => hex(32) },
      { key: "GARAGE_RPC_SECRET", value: () => hex(32) },
      { key: "GARAGE_ADMIN_TOKEN", value: () => hex(32) },
      { key: "GARAGE_ADMIN_PORT", value: "3903" },
    ],
  },
  {
    title: "Email (Mailpit catches everything in development)",
    variables: [
      { key: "SMTP_PORT", value: "1025" },
      { key: "SMTP_URL", value: "smtp://127.0.0.1:1025" },
      { key: "MAIL_FROM_ADDRESS", value: "noreply@clubadmin.test" },
      { key: "MAILPIT_UI_PORT", value: "8025" },
    ],
  },
];

export const ALL_KEYS = ENV_TEMPLATE.flatMap((s) => s.variables.map((v) => v.key));

/** Parses dotenv-style text: KEY=value lines, # comments, optional quotes. */
export function parseEnv(text: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key = "", rawValue = ""] = match;
    let value = rawValue;
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2] ?? "";
    result.set(key, value);
  }
  return result;
}

/** Replaces ${VAR} references with values already known. */
export function expand(value: string, known: ReadonlyMap<string, string>): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (whole, name: string) => known.get(name) ?? whole,
  );
}

/**
 * Returns the lines to append so that `existing` contains every template key.
 * Existing values are never changed.
 */
export function missingEnvLines(existing: ReadonlyMap<string, string>): string[] {
  const known = new Map(existing);
  const lines: string[] = [];
  for (const section of ENV_TEMPLATE) {
    const sectionLines: string[] = [];
    for (const variable of section.variables) {
      if (known.has(variable.key)) continue;
      const raw = typeof variable.value === "function" ? variable.value() : variable.value;
      const value = expand(raw, known);
      known.set(variable.key, value);
      if (variable.comment) sectionLines.push(`# ${variable.comment}`);
      sectionLines.push(`${variable.key}=${value}`);
    }
    if (sectionLines.length > 0) lines.push("", `# ${section.title}`, ...sectionLines);
  }
  return lines;
}

const HEADER = [
  "# Local development settings, generated by `pnpm dev`. Git-ignored: never commit.",
  "# Secrets are random for this machine. Delete this file and run `pnpm dev:clean`",
  "# to start over with fresh secrets and empty databases.",
];

/** Creates .env.local or appends missing keys. Returns the keys that were added. */
export function ensureEnvLocal(path = envLocalFile): string[] {
  const exists = existsSync(path);
  const existing = exists ? parseEnv(readFileSync(path, "utf8")) : new Map<string, string>();
  const lines = missingEnvLines(existing);
  if (lines.length === 0) return [];
  const added = lines
    .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l))
    .map((l) => l.split("=", 1)[0] ?? "");
  const content = exists
    ? `${readFileSync(path, "utf8").replace(/\n*$/, "\n")}${lines.join("\n")}\n`
    : `${HEADER.join("\n")}\n${lines.join("\n")}\n`;
  writeFileSync(path, content, { mode: 0o600 });
  return added;
}

/** Merged environment: .env, then .env.local (later wins). */
export function loadEnv(): Map<string, string> {
  const merged = new Map<string, string>();
  for (const file of [envFile, envLocalFile]) {
    if (!existsSync(file)) continue;
    for (const [key, value] of parseEnv(readFileSync(file, "utf8"))) merged.set(key, value);
  }
  return merged;
}

export function requireEnv(env: ReadonlyMap<string, string>, key: string): string {
  const value = env.get(key);
  if (value === undefined || value === "") {
    throw new Error(`${key} is not set. Run \`pnpm dev\` once to generate .env.local.`);
  }
  return value;
}
