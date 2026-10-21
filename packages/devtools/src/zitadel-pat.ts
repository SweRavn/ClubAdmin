// SPDX-License-Identifier: AGPL-3.0-only
// The `clubadmin-config` machine user's token, written by Zitadel's first
// start into the bootstrap volume. The Zitadel image has no shell, so the file
// is copied out with `docker compose cp`.

import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { composeCapture } from "./compose.ts";
import { localDir } from "./paths.ts";

export const ZITADEL_PAT_PATH = "/zitadel/bootstrap/admin.pat";

export function readZitadelAdminPat(): string {
  mkdirSync(localDir, { recursive: true });
  const target = join(localDir, "zitadel-admin.pat");
  const result = composeCapture(["cp", `zitadel:${ZITADEL_PAT_PATH}`, target]);
  if (result.status !== 0) {
    throw new Error(
      `Could not read Zitadel's machine-user token. Is Zitadel running (pnpm dev:services)?\n${result.stderr.trim()}`,
    );
  }
  try {
    return readFileSync(target, "utf8").trim();
  } finally {
    rmSync(target, { force: true });
  }
}
