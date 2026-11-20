// SPDX-License-Identifier: AGPL-3.0-only
// Which form field a request field the API refused belongs to (P2.7c, P2.7d).

/**
 * The form field of a request field's path (P2.7c, P2.7d): the action's
 * `apiFields` for the whole path (`*` for a list's index, e.g.
 * `activities.*.startsAt` → `a.*.startTime`) or its first segment, else the
 * path's first segment. When the form has no field of that name, a field of
 * the form that starts with it (a list's first row) or its singular
 * (`groupIds` → `groupId`), so that a refused value is always marked.
 */
export function formFieldOf(
  path: string,
  apiFields: Record<string, string>,
  formNames: ReadonlySet<string>,
): string | null {
  const segments = path.split(/[.[\]]+/).filter(Boolean);
  const first = segments[0] ?? "";
  if (!first) return null;
  const index = segments.find((s) => /^\d+$/.test(s));
  const pattern = segments.map((s) => (/^\d+$/.test(s) ? "*" : s)).join(".");
  const nested = apiFields[pattern];
  const name =
    nested && index !== undefined ? nested.replace("*", index) : (apiFields[first] ?? first);
  if (formNames.size === 0 || formNames.has(name)) return name;
  // The form names the field as the API does (`q.3.label`).
  if (formNames.has(segments.join("."))) return segments.join(".");
  const prefixed = [...formNames].find((n) => n.startsWith(`${name}.`));
  if (prefixed) return prefixed;
  if (name.endsWith("s") && formNames.has(name.slice(0, -1))) return name.slice(0, -1);
  return name;
}
