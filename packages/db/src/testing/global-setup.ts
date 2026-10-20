// SPDX-License-Identifier: AGPL-3.0-only
// Vitest globalSetup for integration tests: builds the template database once
// per run (or reuses it when the migrations have not changed).
import { ensureTemplate } from "./template.ts";

export async function setup(): Promise<void> {
  await ensureTemplate();
}
