// SPDX-License-Identifier: AGPL-3.0-only
// Plugins (P2.7, ADR 0051): the installation's plugins for operators, a
// club's plugins with their settings (secrets by name only, never their
// values), and the background-check types and requirements of the club's
// enabled plugins (the screens come with P2.8).

import { z } from "../zod.ts";

const pluginId = z.string().regex(/^[a-z]{2,}(\.[a-z0-9-]+)+$/);
const configValue = z.union([z.string().max(500), z.number(), z.boolean()]);

/** A plugin's texts in the caller's language (labels, reason codes). */
const texts = z.record(z.string(), z.string());

const configField = z.object({
  key: z.string(),
  type: z.enum(["text", "number", "boolean", "choice"]),
  label: z.string(),
  required: z.boolean(),
  options: z.array(z.string()).optional(),
  pattern: z.string().optional(),
  maxLength: z.number().int().optional(),
});

export const InstalledPluginSchema = z
  .object({
    id: pluginId,
    version: z.string(),
    publisher: z.string(),
    licence: z.string(),
    pluginApi: z.string(),
    capabilities: z.array(z.string()),
    regions: z.array(z.string()),
    /** The data the plugin is given (declared in its manifest). */
    data: z.array(z.string()),
    network: z.array(z.string()),
  })
  .openapi("InstalledPlugin");
export type InstalledPlugin = z.infer<typeof InstalledPluginSchema>;

export const InstalledPluginListSchema = z
  .object({ items: z.array(InstalledPluginSchema), pluginApi: z.string() })
  .openapi("InstalledPluginList");
export type InstalledPluginList = z.infer<typeof InstalledPluginListSchema>;

export const ClubPluginSchema = InstalledPluginSchema.extend({
  enabled: z.boolean(),
  config: z.record(z.string(), configValue),
  configFields: z.array(configField),
  /** The declared secrets and whether each is set (values are never returned). */
  secrets: z.array(z.object({ name: z.string(), set: z.boolean() })),
  texts,
}).openapi("ClubPlugin");
export type ClubPlugin = z.infer<typeof ClubPluginSchema>;

export const ClubPluginListSchema = z
  .object({ items: z.array(ClubPluginSchema) })
  .openapi("ClubPluginList");
export type ClubPluginList = z.infer<typeof ClubPluginListSchema>;

export const ClubPluginParamsSchema = z.object({ clubId: z.uuid(), pluginId });

export const PutClubPluginSchema = z
  .object({
    enabled: z.boolean(),
    /** Validated against the plugin's manifest (unknown keys refused). */
    config: z.record(z.string(), configValue.nullable()).default({}),
    /** New values for declared secrets; null removes one; left out: unchanged. */
    secrets: z.record(z.string(), z.string().min(1).max(4000).nullable()).default({}),
  })
  .strict()
  .openapi("PutClubPlugin");
export type PutClubPluginInput = z.input<typeof PutClubPluginSchema>;

export const BackgroundCheckTypesSchema = z
  .object({
    items: z.array(
      z.object({
        pluginId,
        key: z.string(),
        name: z.string(),
        initiator: z.enum(["person", "club", "federation"]),
        maxAgeDaysWhenPresented: z.number().int().nullable(),
        recheckMonths: z.number().int().nullable(),
        minAge: z.number().int().nullable(),
        methods: z.array(z.string()),
      }),
    ),
    requirements: z.array(
      z.object({
        pluginId,
        category: z.string(),
        checkType: z.string(),
        level: z.enum(["required", "recommended"]),
        basis: z.string(),
      }),
    ),
    /** Plugins that failed to answer (their types are missing above). */
    unavailable: z.array(pluginId),
  })
  .openapi("BackgroundCheckTypes");
export type BackgroundCheckTypes = z.infer<typeof BackgroundCheckTypesSchema>;
