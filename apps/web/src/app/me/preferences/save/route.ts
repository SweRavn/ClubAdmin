// SPDX-License-Identifier: AGPL-3.0-only
// Form action of /me/preferences: PATCH /api/v1/me/preferences.

import { type NextRequest, type NextResponse } from "next/server";

import { apiFetch } from "../../../../server/api.ts";
import { CSRF_COOKIE, SESSION_COOKIE } from "../../../../server/cookies.ts";
import { checkCsrf } from "../../../../server/csrf.ts";
import { formText, problem, redirectTo, siteOrigin } from "../../../../server/http.ts";
import { freshSession, loadSession } from "../../../../server/sessions.ts";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const loaded = await loadSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!loaded) return redirectTo("/login?returnTo=%2Fme%2Fpreferences");
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
  if (!session) return redirectTo("/login?returnTo=%2Fme%2Fpreferences");
  const locale = formText(form, "locale").trim();
  const timeZone = formText(form, "timeZone").trim();
  const res = await apiFetch("/api/v1/me/preferences", session.record, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ locale: locale || null, timeZone: timeZone || null }),
  });
  return redirectTo(res.ok ? "/me/preferences?saved=1" : "/me/preferences?error=1");
}
