// SPDX-License-Identifier: AGPL-3.0-only
// Where seeding is allowed (docs/seed-data.md, "Rules"): never in production
// or on the hosted service; resetting (dropping the database) only in
// development, against a local database or an explicitly allowed host.

export interface SeedEnv {
  NODE_ENV?: string | undefined;
  DEPLOYMENT_MODE?: string | undefined;
  SEED_ALLOW_HOST?: string | undefined;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "postgres"]);

/** Why seeding is refused here, or null. */
export function seedRefusal(env: SeedEnv): string | null {
  if (env.NODE_ENV === "production") return "refusing to seed with NODE_ENV=production";
  if (env.DEPLOYMENT_MODE === "hosted") return "refusing to seed with DEPLOYMENT_MODE=hosted";
  return null;
}

/** Why dropping and recreating the database is refused here, or null. */
export function resetRefusal(env: SeedEnv, databaseUrl: string): string | null {
  const refusal = seedRefusal(env);
  if (refusal) return refusal;
  if (env.NODE_ENV !== "development") return "db:reset needs NODE_ENV=development";
  const host = new URL(databaseUrl).hostname;
  if (!LOCAL_HOSTS.has(host) && env.SEED_ALLOW_HOST !== host) {
    return `db:reset refuses the database host ${host} (set SEED_ALLOW_HOST=${host} to allow it)`;
  }
  return null;
}
