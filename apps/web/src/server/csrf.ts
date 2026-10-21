// SPDX-License-Identifier: AGPL-3.0-only
// CSRF protection for state-changing requests from the browser to the BFF:
// double submit (X-CSRF-Token header or csrf form field equal to the
// __Host-csrf cookie and to the token stored in the session) plus a
// same-origin check of the Origin header.

import { timingSafeEqual } from "node:crypto";

export const CSRF_HEADER = "x-csrf-token";

const equal = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export interface CsrfInput {
  method: string;
  /** Origin header of the request (absent for some same-origin GETs). */
  origin: string | null;
  /** The site's own origin, from PUBLIC_WEB_URL. */
  expectedOrigin: string;
  /** Token from the header or form field. */
  submitted: string | null;
  cookie: string | null;
  session: string | null;
}

export const isSafeMethod = (method: string) =>
  ["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());

/** True if the request may proceed. */
export function checkCsrf(input: CsrfInput): boolean {
  if (isSafeMethod(input.method)) return true;
  if (input.origin !== null && input.origin !== input.expectedOrigin) return false;
  if (!input.submitted || !input.cookie || !input.session) return false;
  return equal(input.submitted, input.cookie) && equal(input.submitted, input.session);
}

/** Same-origin check for forms that run before a session exists (login). */
export function isSameOrigin(origin: string | null, expectedOrigin: string): boolean {
  return origin === expectedOrigin;
}
