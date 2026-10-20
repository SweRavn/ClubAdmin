// SPDX-License-Identifier: AGPL-3.0-only
// pnpm db:bootstrap | db:migrate | db:status, and lint-migrations (pnpm lint).
import { loadEnvFiles } from "@clubadmin/server-kit";
import pg from "pg";

import { bootstrap, passwordsFromEnv } from "./bootstrap.ts";
import { compareMigrations, migrate, readMigrationFiles } from "./migrate.ts";
import { lintMigrations } from "./migration-lint.ts";
import { redactUrl } from "./urls.ts";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(
      `${name} is not set (see .env.example; \`pnpm dev:services\` generates .env.local)`,
    );
  return value;
}

async function main(command: string | undefined): Promise<number> {
  loadEnvFiles();
  switch (command) {
    case "bootstrap": {
      const adminUrl = requireEnv("DATABASE_ADMIN_URL");
      await bootstrap({ adminUrl, passwords: passwordsFromEnv() });
      console.log(`Bootstrapped roles and grants on ${redactUrl(adminUrl)}`);
      return 0;
    }
    case "migrate": {
      const result = await migrate({
        ownerUrl: requireEnv("DATABASE_OWNER_URL"),
        log: (m) => console.log(m),
      });
      console.log(
        result.applied.length === 0
          ? `Database is up to date (${result.alreadyApplied} migrations applied).`
          : `Applied ${result.applied.length} migration(s).`,
      );
      return 0;
    }
    case "status": {
      const client = new pg.Client({ connectionString: requireEnv("DATABASE_OWNER_URL") });
      await client.connect();
      try {
        const { rows } = await client
          .query<{ name: string; checksum: string }>(
            "SELECT name, checksum FROM app_meta.schema_migrations",
          )
          .catch(() => ({ rows: [] }));
        const status = compareMigrations(readMigrationFiles(), rows);
        console.log(JSON.stringify(status, null, 2));
        return status.pending.length + status.changed.length === 0 ? 0 : 1;
      } finally {
        await client.end();
      }
    }
    case "lint-migrations": {
      const warnings = lintMigrations(readMigrationFiles());
      for (const w of warnings) {
        const message = `${w.file}:${w.line}: ${w.message}`;
        console.warn(
          process.env.GITHUB_ACTIONS
            ? `::warning file=packages/db/migrations/${w.file}.sql,line=${w.line}::${w.message}`
            : `warning: ${message}`,
        );
      }
      return 0;
    }
    default:
      console.error("Usage: node src/cli.ts bootstrap|migrate|status|lint-migrations");
      return 1;
  }
}

try {
  process.exitCode = await main(process.argv[2]);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
