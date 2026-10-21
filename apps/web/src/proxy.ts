// SPDX-License-Identifier: AGPL-3.0-only
// Runs before every page request: a fresh CSP nonce (Next.js reads it from
// the request's Content-Security-Policy header and adds it to its scripts),
// and the requested path for the server components (returnTo after login,
// the current club).

import { type NextRequest, NextResponse } from "next/server";

import { PATH_HEADER } from "./server/data.ts";
import { contentSecurityPolicy, newNonce } from "./server/security-headers.ts";

const formActions = (): string[] => {
  const issuer = process.env.AUTH_ISSUER;
  try {
    return issuer ? [new URL(issuer).origin] : [];
  } catch {
    return [];
  }
};

export function proxy(request: NextRequest): NextResponse {
  const csp = contentSecurityPolicy({
    nonce: newNonce(),
    development: process.env.NODE_ENV === "development",
    formActions: formActions(),
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("content-security-policy", csp);
  requestHeaders.set(PATH_HEADER, `${request.nextUrl.pathname}${request.nextUrl.search}`);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only: not the API proxy, static files or prefetches.
      source: "/((?!api/|_next/static|_next/image|favicon.ico|robots.txt).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
