// SPDX-License-Identifier: AGPL-3.0-only
// Small helpers shared by the route handlers.

import {
  PROBLEM_CONTENT_TYPE,
  PROBLEM_TYPES,
  type ProblemSlug,
  problemTypeUri,
} from "@clubadmin/shared";
import { NextResponse } from "next/server";

import { webConfig } from "./config.ts";
import {
  CSRF_COOKIE,
  csrfCookieOptions,
  FLOW_COOKIE,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "./cookies.ts";

/** Absolute URL on this site (behind Caddy the request URL is the internal one). */
export const siteUrl = (path: string) => new URL(path, webConfig().PUBLIC_WEB_URL).toString();
export const siteOrigin = () => new URL(webConfig().PUBLIC_WEB_URL).origin;

export function redirectTo(path: string, status = 303): NextResponse {
  return NextResponse.redirect(siteUrl(path), status);
}

export function problem(slug: ProblemSlug, detail?: string): NextResponse {
  return NextResponse.json(
    {
      type: problemTypeUri(slug),
      title: slug,
      status: PROBLEM_TYPES[slug],
      ...(detail ? { detail } : {}),
    },
    { status: PROBLEM_TYPES[slug], headers: { "content-type": PROBLEM_CONTENT_TYPE } },
  );
}

export function setSessionCookies(
  response: NextResponse,
  session: { id: string; csrf: string },
): void {
  response.cookies.set(SESSION_COOKIE, session.id, sessionCookieOptions);
  response.cookies.set(CSRF_COOKIE, session.csrf, csrfCookieOptions);
  response.cookies.delete({ name: FLOW_COOKIE, path: "/", secure: true });
}

export function clearSessionCookies(response: NextResponse): void {
  for (const name of [SESSION_COOKIE, CSRF_COOKIE])
    response.cookies.delete({ name, path: "/", secure: true });
}

/** A text field of a submitted form ("" if missing or a file). */
export function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}
