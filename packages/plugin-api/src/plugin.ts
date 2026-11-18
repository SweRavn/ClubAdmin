// SPDX-License-Identifier: AGPL-3.0-only
// A plugin is its manifest and the capabilities it implements. Every method
// takes and returns JSON and is asynchronous, so the same plugin can later
// run out of process behind HTTP (ADR 0051 decision 2).

import type { BackgroundChecks } from "./checks.ts";
import type { GrantReporting } from "./grants.ts";
import { type Manifest, type ManifestInput, ManifestSchema } from "./manifest.ts";

export interface Plugin {
  manifest: Manifest;
  grantReporting?: GrantReporting;
  backgroundChecks?: BackgroundChecks;
}

/** Declares a plugin; the manifest is parsed here, so defaults are filled and mistakes found at start. */
export function definePlugin(plugin: {
  manifest: ManifestInput;
  grantReporting?: GrantReporting;
  backgroundChecks?: BackgroundChecks;
}): Plugin {
  return { ...plugin, manifest: ManifestSchema.parse(plugin.manifest) };
}

/** Problems with how a plugin's capabilities match its manifest (empty: fine). */
export function capabilityProblems(plugin: Plugin): string[] {
  const problems: string[] = [];
  const declared = new Set(plugin.manifest.capabilities);
  if (declared.has("grant-reporting") !== Boolean(plugin.grantReporting)) {
    problems.push("grant-reporting is declared but not implemented, or the other way round");
  }
  if (declared.has("background-checks") !== Boolean(plugin.backgroundChecks)) {
    problems.push("background-checks is declared but not implemented, or the other way round");
  }
  return problems;
}
