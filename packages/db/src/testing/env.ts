// SPDX-License-Identifier: AGPL-3.0-only
import { loadEnvFiles } from "@clubadmin/server-kit";

import { passwordsFromEnv } from "../bootstrap.ts";
import { ROLES } from "../roles.ts";
import { withCredentials } from "../urls.ts";

export interface TestEnv {
  adminUrl: string;
  passwords: ReturnType<typeof passwordsFromEnv>;
  urlFor(role: keyof typeof ROLES, database: string): string;
}

/** Reads DATABASE_ADMIN_URL and the role passwords (.env.local from pnpm dev:services). */
export function testEnv(): TestEnv {
  loadEnvFiles();
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl) {
    throw new Error(
      "Integration tests need DATABASE_ADMIN_URL: run `pnpm dev:services` first (it creates .env.local).",
    );
  }
  const passwords = passwordsFromEnv();
  for (const role of ["owner", "app", "operator", "retention"] as const) {
    if (!passwords[role])
      throw new Error(
        `Integration tests need the ${role} role password (run \`pnpm dev:services\`).`,
      );
  }
  return {
    adminUrl,
    passwords,
    urlFor(role, database) {
      const url = withCredentials(adminUrl, ROLES[role], passwords[role] ?? "");
      const parsed = new URL(url);
      parsed.pathname = `/${database}`;
      return parsed.toString();
    },
  };
}
