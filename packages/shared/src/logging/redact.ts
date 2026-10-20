// SPDX-License-Identifier: AGPL-3.0-only
// Keys whose values must never appear in logs, traces or error reports
// (CLAUDE.md rule 5). Matching is case-insensitive and ignores "_" and "-",
// so "given_name", "givenName" and "Given-Name" are all redacted.

export const REDACTED = "[redacted]";

export const REDACTED_KEYS: readonly string[] = [
  // identity and contact
  "name",
  "givenName",
  "familyName",
  "firstName",
  "lastName",
  "displayName",
  "email",
  "emailAddress",
  "phone",
  "phoneNumber",
  "mobile",
  "address",
  "street",
  "postalCode",
  "birthDate",
  "personalIdentityNumber",
  "personnummer",
  // content written by people
  "message",
  "body",
  "text",
  "content",
  "comment",
  "note",
  "notes",
  // database error details and query parameters can contain values
  "detail",
  "params",
  "parameters",
  // credentials and secrets
  "authorization",
  "cookie",
  "setCookie",
  "password",
  "token",
  "accessToken",
  "refreshToken",
  "idToken",
  "secret",
  "apiKey",
];

const normalise = (key: string) => key.replace(/[-_]/g, "").toLowerCase();
const REDACTED_SET = new Set(REDACTED_KEYS.map(normalise));

export const isRedactedKey = (key: string) => REDACTED_SET.has(normalise(key));

const MAX_DEPTH = 8;

/**
 * Returns a copy of `value` with the values of sensitive keys replaced by
 * "[redacted]", at any depth. Handles cycles, arrays, Errors, Maps and Buffers.
 */
export function redact(value: unknown): unknown {
  const seen = new WeakSet<object>();

  const walk = (current: unknown, depth: number): unknown => {
    if (current === null || typeof current !== "object") return current;
    if (seen.has(current)) return "[circular]";
    if (depth > MAX_DEPTH) return "[truncated]";
    seen.add(current);

    if (Buffer.isBuffer(current) || ArrayBuffer.isView(current))
      return `[binary ${current.byteLength} bytes]`;
    if (Array.isArray(current)) return current.map((item) => walk(item, depth + 1));
    if (current instanceof Date) return current;
    if (current instanceof Map) {
      return Object.fromEntries(
        [...current.entries()].map(([k, v]) => [
          String(k),
          isRedactedKey(String(k)) ? REDACTED : walk(v, depth + 1),
        ]),
      );
    }

    const result: Record<string, unknown> = {};
    const source = current as Record<string, unknown>;
    if (current instanceof Error) {
      // Error messages and stacks are kept; they must not contain personal data
      // (see docs/security.md). Extra properties are walked like any object.
      result.type = current.name;
      result.message = current.message;
      if (current.stack !== undefined) result.stack = current.stack;
    }
    for (const key of Object.keys(source)) {
      result[key] = isRedactedKey(key) ? REDACTED : walk(source[key], depth + 1);
    }
    return result;
  };

  return walk(value, 0);
}
