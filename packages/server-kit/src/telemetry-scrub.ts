// SPDX-License-Identifier: AGPL-3.0-only
import { isRedactedKey } from "@clubadmin/shared";

const URL_ATTRIBUTES = ["url.full", "http.url", "http.target", "url.original", "url.path"];

/**
 * Paths whose last segment is a secret (calendar feeds and answer links,
 * P1.11): the secret is replaced, so it never reaches traces.
 */
const SECRET_PATHS = /(\/(?:cal|calendar-answers|answer))\/[^/?#]+/g;

/** A URL or path without its query string and without secrets in the path. */
export const scrubUrl = (value: string): string =>
  (value.split("?")[0] ?? "").replace(SECRET_PATHS, "$1/[redacted]");
const DROPPED_ATTRIBUTES = ["url.query"];

/** Removes query strings and personal-data attributes from span attributes (mutates). */
export function scrubSpanAttributes(attributes: Record<string, unknown>): void {
  for (const key of Object.keys(attributes)) {
    const value = attributes[key];
    if (DROPPED_ATTRIBUTES.includes(key)) {
      delete attributes[key];
    } else if (URL_ATTRIBUTES.includes(key) && typeof value === "string") {
      attributes[key] = scrubUrl(value);
    } else if (isRedactedKey(key.split(".").pop() ?? key)) {
      delete attributes[key];
    }
  }
}
