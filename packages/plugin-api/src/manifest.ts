// SPDX-License-Identifier: AGPL-3.0-only
// A plugin's manifest (ADR 0051 decision 2): who it is, what it can do, where
// it applies, the data it needs (nothing else is given to it), its per-club
// configuration, the secrets and hosts it uses, and its texts in sv, en and
// nb. Everything is JSON, so the same manifest works in process and, later,
// out of process.

import { z } from "@clubadmin/shared";

/** The version of this contract; a plugin states the range it needs (`pluginApi`). */
export const PLUGIN_API_VERSION = "1.0.0";

export const CAPABILITIES = ["grant-reporting", "background-checks"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * The closed list of data a plugin may declare. The host derives each from
 * its own model; `disability` means "takes part in an adapted group" (a
 * group flag, never health data about a person; decision of 2026-11-18).
 */
export const DATA_FIELDS = [
  "name",
  "birthDate",
  "sex",
  "personalIdentityNumber",
  "disability",
  "homeMunicipality",
  "membershipStatus",
  "membershipFeePaid",
  "groupSport",
  "attendance",
  "leaders",
  "clubRoles",
  "groupRoles",
] as const;
export type DataField = (typeof DATA_FIELDS)[number];

export const PLUGIN_LOCALES = ["sv", "en", "nb"] as const;
export type PluginLocale = (typeof PLUGIN_LOCALES)[number];

/**
 * Licences an in-process plugin may have: AGPL-3.0-only code may be combined
 * with them (ADR 0051, `docs/licensing.md`). Anything else is refused.
 */
export const PLUGIN_LICENCES = [
  "AGPL-3.0-only",
  "AGPL-3.0-or-later",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
  "Apache-2.0",
  "MIT",
  "MIT-0",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "MPL-2.0",
] as const;

const textKey = z.string().regex(/^[a-zA-Z][\w.-]{0,79}$/);

/** One per-club setting; the host generates the form from these. */
export const ConfigFieldSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/),
    type: z.enum(["text", "number", "boolean", "choice"]),
    /** A key of the manifest's texts. */
    label: textKey,
    required: z.boolean().default(false),
    /** For `choice`: the values; their labels are texts `<label>.<value>`. */
    options: z.array(z.string().regex(/^[a-z0-9_-]{1,40}$/)).optional(),
    /** For `text`: a regular expression the value must match. */
    pattern: z.string().max(200).optional(),
    maxLength: z.number().int().min(1).max(500).optional(),
  })
  .strict()
  .refine((f) => f.type !== "choice" || (f.options?.length ?? 0) > 0, {
    message: "a choice needs options",
  });
export type ConfigField = z.infer<typeof ConfigFieldSchema>;

const semver = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export const ManifestSchema = z
  .object({
    /** Reverse DNS, e.g. `se.rf.lok`. */
    id: z.string().regex(/^[a-z]{2,}(\.[a-z0-9-]+)+$/),
    version: z.string().regex(semver),
    publisher: z.string().min(1).max(100),
    /** SPDX identifier, one of PLUGIN_LICENCES. */
    licence: z.string().min(1).max(50),
    /** The contract versions it works with: `1.0.0` or `^1.0.0`. */
    pluginApi: z.string().regex(/^\^?\d+\.\d+\.\d+$/),
    capabilities: z.array(z.enum(CAPABILITIES)).min(1),
    /** ISO 3166-1 (`SE`), ISO 3166-2 (`SE-AB`) or a municipality (`SE:0180`). */
    regions: z.array(z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{1,3}|:[0-9A-Za-z]{1,10})?$/)).min(1),
    data: z.array(z.enum(DATA_FIELDS)),
    config: z.array(ConfigFieldSchema).default([]),
    /** Names only; values are set per club and encrypted by the host. */
    secrets: z.array(z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/)).default([]),
    /** Hosts the plugin may call (exact names). */
    network: z
      .array(z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9-]+)+$/))
      .default([]),
    /** Every label and reason code, per locale (the same keys in each). */
    texts: z.object({
      sv: z.record(textKey, z.string().min(1).max(500)),
      en: z.record(textKey, z.string().min(1).max(500)),
      nb: z.record(textKey, z.string().min(1).max(500)),
    }),
  })
  .strict();
export type Manifest = z.infer<typeof ManifestSchema>;
export type ManifestInput = z.input<typeof ManifestSchema>;

/** Whether `version` satisfies `range` (`x.y.z` exactly, or `^x.y.z`: same major, not lower). */
export function satisfiesApiRange(range: string, version: string = PLUGIN_API_VERSION): boolean {
  const parse = (v: string) => v.replace(/^\^/, "").split("-")[0]!.split(".").map(Number);
  const [rMajor, rMinor, rPatch] = parse(range) as [number, number, number];
  const [vMajor, vMinor, vPatch] = parse(version) as [number, number, number];
  if (!range.startsWith("^")) return rMajor === vMajor && rMinor === vMinor && rPatch === vPatch;
  if (rMajor !== vMajor) return false;
  if (vMinor !== rMinor) return vMinor > rMinor;
  return vPatch >= rPatch;
}

/** Problems with a manifest that the schema alone cannot see (empty: fine). */
export function manifestProblems(manifest: Manifest): string[] {
  const problems: string[] = [];
  if (!(PLUGIN_LICENCES as readonly string[]).includes(manifest.licence)) {
    problems.push(`licence ${manifest.licence} is not allowed for a plugin`);
  }
  if (!satisfiesApiRange(manifest.pluginApi)) {
    problems.push(`plugin API ${manifest.pluginApi} does not match ${PLUGIN_API_VERSION}`);
  }
  if (new Set(manifest.capabilities).size !== manifest.capabilities.length) {
    problems.push("a capability is listed twice");
  }
  if (new Set(manifest.data).size !== manifest.data.length)
    problems.push("a data field is listed twice");
  const keys = (locale: PluginLocale) => Object.keys(manifest.texts[locale]).sort().join("\n");
  for (const locale of ["en", "nb"] as const) {
    if (keys(locale) !== keys("sv"))
      problems.push(`texts in ${locale} do not have the same keys as sv`);
  }
  for (const field of manifest.config) {
    const labels = [field.label, ...(field.options ?? []).map((o) => `${field.label}.${o}`)];
    for (const label of labels) {
      if (!(label in manifest.texts.sv)) problems.push(`config label ${label} has no text`);
    }
  }
  return problems;
}
