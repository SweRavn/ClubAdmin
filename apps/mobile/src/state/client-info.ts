// SPDX-License-Identifier: AGPL-3.0-only
// What /meta/client means for this app (ADR 0029): whether it must or should
// be updated, and which server features it may use.

import { compareVersions } from "@clubadmin/shared";

import type { ClientInfo } from "../api/queries.ts";

export type UpdateState = "ok" | "recommended" | "required";

export function updateState(
  info: ClientInfo | undefined,
  platform: string,
  version: string,
): UpdateState {
  if (!info || (platform !== "ios" && platform !== "android")) return "ok";
  const support = info.apps[platform];
  if (compareVersions(version, support.minimumVersion) < 0) return "required";
  if (compareVersions(version, support.recommendedVersion) < 0) return "recommended";
  return "ok";
}

/**
 * Features every server this app version talks to has (they existed before
 * /meta/client did). Anything newer is used only when the server lists it.
 */
const BASELINE_FEATURES = new Set(["me.preferences", "me.groups"]);

export function hasFeature(info: ClientInfo | undefined, name: string): boolean {
  return info ? info.features.includes(name) : BASELINE_FEATURES.has(name);
}

export function storeUrl(info: ClientInfo | undefined, platform: string): string | null {
  if (!info || (platform !== "ios" && platform !== "android")) return null;
  return info.apps[platform].storeUrl;
}
