// SPDX-License-Identifier: AGPL-3.0-only
// What the API tells installed apps (GET /api/v1/meta/client, ADR 0029):
// which app versions it supports, feature flags, and what this server can
// do. A new app can meet an older (self-hosted) server, so apps check
// `features` before calling an endpoint added later. Values are strings, not
// enums: an old app must not fail on a feature or flag it does not know.

import { z } from "../zod.ts";

/** Headers the mobile app sends with every request (session list; never a device identifier). */
export const CLIENT_PLATFORM_HEADER = "x-client-platform";
export const CLIENT_VERSION_HEADER = "x-client-version";
/** Device model and OS version, e.g. "Pixel 8 (Android 16)". */
export const CLIENT_DEVICE_HEADER = "x-client-device";

export const MOBILE_PLATFORMS = ["ios", "android"] as const;
export type MobilePlatform = (typeof MOBILE_PLATFORMS)[number];

/** Major version of the API (`/api/v1`). */
export const API_MAJOR_VERSION = 1;

/**
 * Capabilities of this server version. Add one when an endpoint or behaviour
 * appears that apps must detect; never remove or rename one within /api/v1.
 */
export const SERVER_FEATURES = [
  "me.preferences",
  "me.groups",
  "sessions.mobile",
  "rate-limits.account",
  /** P1.7: the inbox and notification settings; "notifications.push" only with a push provider. */
  "notifications.inbox",
  "notifications.push",
] as const;

/** Dotted numeric version, e.g. "1.4.0". */
export const AppVersionSchema = z
  .string()
  .regex(/^\d+(\.\d+){0,2}$/)
  .openapi({ example: "1.0.0" });

export const AppSupportSchema = z
  .object({
    /** Below this version the app must be updated before it can be used. */
    minimumVersion: AppVersionSchema,
    /** Below this version the app suggests an update. */
    recommendedVersion: AppVersionSchema,
    /** Store page, if published. */
    storeUrl: z.url().nullable(),
  })
  .openapi("AppSupport");

export const ClientInfoResponseSchema = z
  .object({
    apiVersion: z.number().int().openapi({ example: API_MAJOR_VERSION }),
    serverVersion: z.string().openapi({ example: "0.0.0" }),
    apps: z.object({ ios: AppSupportSchema, android: AppSupportSchema }),
    /** Server capabilities (see SERVER_FEATURES); unknown values are ignored by clients. */
    features: z.array(z.string()),
    /** Feature flags switched on or off for this server. */
    flags: z.record(z.string(), z.boolean()),
  })
  .openapi("ClientInfoResponse");

export type AppSupport = z.infer<typeof AppSupportSchema>;
export type ClientInfoResponse = z.infer<typeof ClientInfoResponseSchema>;

/** Compares dotted numeric versions ("1.10" > "1.9"); missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** Parses FEATURE_FLAGS ("name,other=false"): a bare name is on. */
export function parseFeatureFlags(value: string | undefined): Record<string, boolean> {
  const flags: Record<string, boolean> = {};
  for (const entry of (value ?? "").split(",")) {
    const [name = "", setting] = entry.split("=").map((part) => part.trim());
    if (!/^[a-z][a-z0-9.-]*$/.test(name)) continue;
    flags[name] = setting === undefined || setting === "true" || setting === "on";
  }
  return flags;
}
