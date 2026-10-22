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
      {
        key: "DEV_AUTH_KEY",
        value: () => hex(32),
        comment: "Signs DEV_AUTH tokens (web app and API); development only",
      },
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
        comment: "Superuser connection, only for pnpm db:bootstrap (roles and grants)",
      },
      { key: "DB_OWNER_PASSWORD", value: () => alphanumeric(32) },
      { key: "DB_APP_PASSWORD", value: () => alphanumeric(32) },
      { key: "DB_OPERATOR_PASSWORD", value: () => alphanumeric(32) },
      { key: "DB_RETENTION_PASSWORD", value: () => alphanumeric(32) },
      {
        key: "DATABASE_URL",
        value:
          "postgresql://clubadmin_app:${DB_APP_PASSWORD}@127.0.0.1:${POSTGRES_PORT}/${POSTGRES_DB}",
        comment: "API and worker: unprivileged role, subject to row-level security",
      },
      {
        key: "DATABASE_OWNER_URL",
        value:
          "postgresql://clubadmin_owner:${DB_OWNER_PASSWORD}@127.0.0.1:${POSTGRES_PORT}/${POSTGRES_DB}",
        comment: "Migrations (pnpm db:migrate)",
      },
      {
        key: "DATABASE_RETENTION_URL",
        value:
          "postgresql://clubadmin_retention:${DB_RETENTION_PASSWORD}@127.0.0.1:${POSTGRES_PORT}/${POSTGRES_DB}",
        comment: "Retention and erasure jobs (worker)",
      },
      { key: "ZITADEL_DB_USER", value: "zitadel" },
      { key: "ZITADEL_DB_PASSWORD", value: () => alphanumeric(32) },
    ],
  },
  {
    title: "Field encryption",
    variables: [
      {
        key: "ENCRYPTION_MASTER_KEYS",
        value: () => `dev1:${randomBytes(32).toString("base64")}`,
        comment:
          "id:base64key, comma-separated, current first; wraps the data keys for encrypted fields (docs/security.md)",
      },
      {
        key: "BLIND_INDEX_KEY",
        value: () => randomBytes(32).toString("base64"),
        comment: "Keyed hashes for matching encrypted values (duplicate personal identity numbers)",
      },
    ],
  },
  {
    title: "Web app (backend-for-frontend)",
    variables: [
      { key: "API_INTERNAL_URL", value: "http://127.0.0.1:${API_PORT}" },
      {
        key: "SESSION_ENCRYPTION_KEY",
        value: () => randomBytes(32).toString("base64"),
        comment: "Encrypts the tokens in session records (Valkey)",
      },
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

/**
 * Values generated by earlier versions that must be replaced. `from` returns
 * true when the current value is the outdated one.
 */
export const ENV_UPGRADES: {
  key: string;
  from: (value: string, env: ReadonlyMap<string, string>) => boolean;
  reason: string;
}[] = [
  {
    // Until P0.4 the API used the superuser connection.
    key: "DATABASE_URL",
    from: (value, env) => value === env.get("DATABASE_ADMIN_URL"),
    reason: "now uses the unprivileged clubadmin_app role",
  },
];

/** Applies ENV_UPGRADES to dotenv text. Returns the new text and the keys changed. */
export function upgradeEnvText(text: string): { text: string; upgraded: string[] } {
  const env = parseEnv(text);
  const upgraded: string[] = [];
  let result = text;
  for (const upgrade of ENV_UPGRADES) {
    const value = env.get(upgrade.key);
    if (value === undefined || !upgrade.from(value, env)) continue;
    const variable = ENV_TEMPLATE.flatMap((section) => section.variables).find(
      (v) => v.key === upgrade.key,
    );
    if (!variable) continue;
    const raw = typeof variable.value === "function" ? variable.value() : variable.value;
    result = result.replace(
      new RegExp(`^${upgrade.key}=.*$`, "m"),
      `# ${upgrade.key}: ${upgrade.reason}\n${upgrade.key}=${expand(raw, env)}`,
    );
    upgraded.push(upgrade.key);
  }
  return { text: result, upgraded };
}

/**
 * Creates .env.local, appends missing keys and applies ENV_UPGRADES. Existing
 * values are otherwise never changed. Returns the keys added or upgraded.
 */
export function ensureEnvLocal(path = envLocalFile): string[] {
  const exists = existsSync(path);
  const existing = exists ? parseEnv(readFileSync(path, "utf8")) : new Map<string, string>();
  const lines = missingEnvLines(existing);
  const added = lines
    .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l))
    .map((l) => l.split("=", 1)[0] ?? "");
  const appended = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  const content = exists
    ? `${readFileSync(path, "utf8").replace(/\n*$/, "\n")}${appended}`
    : `${HEADER.join("\n")}\n${appended}`;
  const { text, upgraded } = upgradeEnvText(content);
  if (added.length === 0 && upgraded.length === 0) return [];
  writeFileSync(path, text, { mode: 0o600 });
  return [...added, ...upgraded];
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

/**
 * Sets keys in .env.local (adding or replacing them), for values that a tool
 * owns, such as client IDs written by `pnpm auth:configure`.
 */
export function setEnvValues(
  values: Readonly<Record<string, string>>,
  path = envLocalFile,
): string[] {
  let text = existsSync(path) ? readFileSync(path, "utf8") : `${HEADER.join("\n")}\n`;
  const current = parseEnv(text);
  const changed: string[] = [];
  const appended: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (current.get(key) === value) continue;
    changed.push(key);
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    if (pattern.test(text)) text = text.replace(pattern, () => line);
    else appended.push(line);
  }
  if (changed.length === 0) return [];
  if (appended.length > 0) {
    text = `${text.replace(/\n*$/, "\n")}\n# Written by pnpm auth:configure\n${appended.join("\n")}\n`;
  }
  writeFileSync(path, text, { mode: 0o600 });
  return changed;
}
