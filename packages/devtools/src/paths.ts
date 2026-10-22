// SPDX-License-Identifier: AGPL-3.0-only
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const dockerDir = join(repoRoot, "infra", "docker");
export const backupDir = join(repoRoot, "infra", "backup");
/** Git-ignored folder for generated local files (exported CA certificate, ...). */
export const localDir = join(repoRoot, ".local");
export const envFile = join(repoRoot, ".env");
export const envLocalFile = join(repoRoot, ".env.local");
export const envExampleFile = join(repoRoot, ".env.example");
export const caddyRootCertFile = join(localDir, "caddy-root.crt");
