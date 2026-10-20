// SPDX-License-Identifier: AGPL-3.0-only
import { isRedactedKey } from "@clubadmin/shared";

const URL_ATTRIBUTES = ["url.full", "http.url", "http.target", "url.original"];
const DROPPED_ATTRIBUTES = ["url.query"];

/** Removes query strings and personal-data attributes from span attributes (mutates). */
export function scrubSpanAttributes(attributes: Record<string, unknown>): void {
  for (const key of Object.keys(attributes)) {
    const value = attributes[key];
    if (DROPPED_ATTRIBUTES.includes(key)) {
      delete attributes[key];
    } else if (URL_ATTRIBUTES.includes(key) && typeof value === "string") {
      attributes[key] = value.split("?")[0];
    } else if (isRedactedKey(key.split(".").pop() ?? key)) {
      delete attributes[key];
    }
  }
}
