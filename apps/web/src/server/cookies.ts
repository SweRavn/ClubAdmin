// SPDX-License-Identifier: AGPL-3.0-only
// Cookie names and attributes. __Host- cookies are Secure, Path=/ and bound
// to this host (no Domain), so subdomains cannot set or read them.

export const SESSION_COOKIE = "__Host-session";
/** Readable by the page's script, which sends it back as X-CSRF-Token (double submit). */
export const CSRF_COOKIE = "__Host-csrf";
/** Binds a login flow (state) to the browser that started it. */
export const FLOW_COOKIE = "__Host-auth-flow";
/** The one-time link or code of a new invitation, for its page (2 minutes, that path only). */
export const INVITATION_SECRET_COOKIE = "ca-invitation";

export const sessionCookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
} as const;

export const csrfCookieOptions = { ...sessionCookieOptions, httpOnly: false } as const;

export const flowCookieOptions = { ...sessionCookieOptions, maxAge: 600 } as const;
