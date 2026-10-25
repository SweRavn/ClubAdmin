// SPDX-License-Identifier: AGPL-3.0-only
// Backend-for-frontend proxy: browser calls to /api/* are forwarded to the
// API with the session's tokens (the browser never sees them). Non-GET
// requests need the CSRF token in X-CSRF-Token. While the person is "viewing
// as" a ward, the BFF adds X-On-Behalf-Of.

import { type NextRequest, NextResponse } from "next/server";

import { apiFetch } from "../../../server/api.ts";
import { CSRF_COOKIE, SESSION_COOKIE } from "../../../server/cookies.ts";
import { checkCsrf, CSRF_HEADER, isSafeMethod } from "../../../server/csrf.ts";
import { clearSessionCookies, problem, siteOrigin } from "../../../server/http.ts";
import { freshSession, loadSession } from "../../../server/sessions.ts";

export const dynamic = "force-dynamic";

const FORWARDED_REQUEST_HEADERS = [
  "content-type",
  "accept",
  "accept-language",
  "if-none-match",
  "x-request-id",
];
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "x-request-id",
  "retry-after",
  "etag",
  "cache-control",
  // CSV exports (P1.6) download with their file name.
  "content-disposition",
];

async function proxy(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const { path } = await params;
  // Public metadata (the AGPL source link in the footer) needs no session.
  if (request.method === "GET" && path[0] === "v1" && path[1] === "meta") {
    return relay(
      await apiFetch(`/api/${path.map(encodeURIComponent).join("/")}`, null, {
        forwardedFor: request.headers.get("x-forwarded-for"),
      }),
    );
  }
  const loaded = await loadSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!loaded) return problem("unauthenticated");
  if (
    !checkCsrf({
      method: request.method,
      origin: request.headers.get("origin"),
      expectedOrigin: siteOrigin(),
      submitted: request.headers.get(CSRF_HEADER),
      cookie: request.cookies.get(CSRF_COOKIE)?.value ?? null,
      session: loaded.record.csrf,
    })
  ) {
    return problem("forbidden", "csrf");
  }
  const session = await freshSession(loaded);
  if (!session) {
    const response = problem("unauthenticated");
    clearSessionCookies(response);
    return response;
  }

  const headers: Record<string, string> = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  const upstream = await apiFetch(
    `/api/${path.map(encodeURIComponent).join("/")}${request.nextUrl.search}`,
    session.record,
    {
      method: request.method,
      headers,
      body: isSafeMethod(request.method) ? null : await request.arrayBuffer(),
      // "Viewing as" a ward is session state, never taken from the browser (ADR 0006).
      onBehalfOf: session.record.viewingAs ?? null,
      forwardedFor: request.headers.get("x-forwarded-for"),
    },
  );
  return relay(upstream);
}

function relay(upstream: Response): NextResponse {
  const responseHeaders = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  return new NextResponse(upstream.status === 204 ? null : upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export { proxy as DELETE, proxy as GET, proxy as PATCH, proxy as POST, proxy as PUT };
