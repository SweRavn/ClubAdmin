// SPDX-License-Identifier: AGPL-3.0-only
// Where to go after login or logout. Only paths on this site are accepted,
// so the parameter cannot be used as an open redirect.

export function safeReturnTo(value: string | null | undefined, fallback = "/me"): string {
  if (!value) return fallback;
  // A single leading slash, no scheme-relative (//host) or backslash tricks, no control characters.
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  if (!/^\/(?![/\\])/.test(value) || /[\\\u0000-\u001f\u007f]/.test(value)) return fallback;
  try {
    const url = new URL(value, "https://internal.invalid");
    if (url.origin !== "https://internal.invalid") return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}
