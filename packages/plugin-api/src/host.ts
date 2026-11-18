// SPDX-License-Identifier: AGPL-3.0-only
// What the host uses to run plugins (ADR 0051 decisions 3 and 4): checking a
// plugin at start (manifest, licence, contract version, capabilities),
// validating a club's configuration, and calling a plugin with a timeout,
// its output validated and its failures contained, so a broken plugin shows
// an error and never breaks the request.

import type { z } from "@clubadmin/shared";

import { type ConfigField, manifestProblems, ManifestSchema } from "./manifest.ts";
import { capabilityProblems, type Plugin } from "./plugin.ts";

/** Problems that stop the host from loading a plugin (empty: it can be installed). */
export function pluginProblems(plugin: Plugin): string[] {
  const parsed = ManifestSchema.safeParse(plugin.manifest);
  if (!parsed.success)
    return parsed.error.issues.map((i) => `manifest: ${i.path.join(".")} ${i.message}`);
  return [...manifestProblems(parsed.data), ...capabilityProblems(plugin)];
}

export type ConfigValues = Record<string, string | number | boolean>;

/** Validates a club's configuration against the manifest; returns the clean values or the problems. */
export function validateConfig(
  fields: readonly ConfigField[],
  input: Record<string, unknown>,
): { ok: true; values: ConfigValues } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const values: ConfigValues = {};
  const known = new Set(fields.map((f) => f.key));
  for (const key of Object.keys(input)) if (!known.has(key)) problems.push(`${key}: unknown`);
  for (const field of fields) {
    const value = input[field.key];
    if (value === undefined || value === null || value === "") {
      if (field.required) problems.push(`${field.key}: required`);
      continue;
    }
    switch (field.type) {
      case "text":
        if (typeof value !== "string") problems.push(`${field.key}: text expected`);
        else if (value.length > (field.maxLength ?? 200)) problems.push(`${field.key}: too long`);
        else if (field.pattern && !new RegExp(`^(?:${field.pattern})$`).test(value)) {
          problems.push(`${field.key}: does not match`);
        } else values[field.key] = value;
        break;
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value))
          problems.push(`${field.key}: number expected`);
        else values[field.key] = value;
        break;
      case "boolean":
        if (typeof value !== "boolean") problems.push(`${field.key}: boolean expected`);
        else values[field.key] = value;
        break;
      case "choice":
        if (typeof value !== "string" || !field.options?.includes(value)) {
          problems.push(`${field.key}: not one of the options`);
        } else values[field.key] = value;
        break;
    }
  }
  return problems.length ? { ok: false, problems } : { ok: true, values };
}

export const PLUGIN_CALL_ERRORS = [
  "plugin_timeout",
  "plugin_failed",
  "plugin_invalid_output",
] as const;
export type PluginCallError = (typeof PLUGIN_CALL_ERRORS)[number];

export type PluginCallResult<T> =
  | { ok: true; value: T; ms: number }
  | { ok: false; error: PluginCallError; ms: number; detail: string };

/** The default time a call may take (an evaluation of a large period included). */
export const PLUGIN_CALL_TIMEOUT_MS = 10_000;

/**
 * Calls a plugin method: the output is validated against `schema`, a call
 * that takes longer than `timeoutMs` is abandoned, and any failure is
 * returned as a code with a detail for the host's log (never thrown).
 */
export async function callPlugin<T>(
  run: () => Promise<unknown>,
  schema: z.ZodType<T>,
  timeoutMs = PLUGIN_CALL_TIMEOUT_MS,
): Promise<PluginCallResult<T>> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const outcome = await Promise.race([
      Promise.resolve()
        .then(run)
        .then((value) => ({ value })),
      timeout,
    ]);
    if (outcome === "timeout") {
      return { ok: false, error: "plugin_timeout", ms: ms(), detail: `over ${timeoutMs} ms` };
    }
    const parsed = schema.safeParse(outcome.value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        ok: false,
        error: "plugin_invalid_output",
        ms: ms(),
        detail: `${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`.trim(),
      };
    }
    return { ok: true, value: parsed.data, ms: ms() };
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    return { ok: false, error: "plugin_failed", ms: ms(), detail: name };
  } finally {
    clearTimeout(timer);
  }
}

/** Whether a plugin serves a club's country (a region `SE`, `SE-AB` or `SE:0180` serves SE). */
export function servesCountry(plugin: Plugin, country: string): boolean {
  return plugin.manifest.regions.some((r) => r.slice(0, 2) === country);
}
