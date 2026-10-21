// SPDX-License-Identifier: AGPL-3.0-only
// Form action on /me/sessions: revokes one of the person's other sessions through the
// API (which removes it from Valkey and ends the Zitadel session).

import type { NextResponse } from "next/server";
import { type NextRequest } from "next/server";

import { apiFetch } from "../../../../../server/api.ts";
import { CSRF_COOKIE, SESSION_COOKIE } from "../../../../../server/cookies.ts";
import { checkCsrf } from "../../../../../server/csrf.ts";
import { formText, problem, redirectTo, siteOrigin } from "../../../../../server/http.ts";
import { freshSession, loadSession } from "../../../../../server/sessions.ts";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
): Promise<NextResponse> {
  const loaded = await loadSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!loaded) return redirectTo("/login?returnTo=%2Fme%2Fsessions");
  const form = await request.formData();
  if (
    !checkCsrf({
      method: "POST",
      origin: request.headers.get("origin"),
      expectedOrigin: siteOrigin(),
      submitted: formText(form, "csrf"),
      cookie: request.cookies.get(CSRF_COOKIE)?.value ?? null,
      session: loaded.record.csrf,
    })
  ) {
    return problem("forbidden", "csrf");
  }
  const session = await freshSession(loaded);
  if (!session) return redirectTo("/login?returnTo=%2Fme%2Fsessions");
  const { sessionId } = await params;
  await apiFetch(`/api/v1/me/sessions/${encodeURIComponent(sessionId)}`, session.record, {
    method: "DELETE",
  });
  return redirectTo("/me/sessions");
}
