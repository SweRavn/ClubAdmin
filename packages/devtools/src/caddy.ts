// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, readFileSync } from "node:fs";

import { composeCapture } from "./compose.ts";
import { caddyRootCertFile, localDir } from "./paths.ts";

const CADDY_ROOT_CERT = "/data/caddy/pki/authorities/local/root.crt";

/** Copies Caddy's local root CA certificate to .local/caddy-root.crt and returns its PEM. */
export function exportCaddyRootCert(): string {
  mkdirSync(localDir, { recursive: true });
  const result = composeCapture(["cp", `caddy:${CADDY_ROOT_CERT}`, caddyRootCertFile]);
  if (result.status !== 0) {
    throw new Error(
      `Could not copy Caddy's root certificate. Is Caddy running (pnpm dev:services)?\n${result.stderr.trim()}`,
    );
  }
  return readFileSync(caddyRootCertFile, "utf8");
}
