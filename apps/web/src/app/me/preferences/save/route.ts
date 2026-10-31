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
  if (res.ok) return redirectTo("/me/preferences?saved=1");
  return redirectTo(`/me/preferences?error=${await errorOf(res)}`);
}

/** Which field the API refused, so the page shows its own message (P1.6b). */
async function errorOf(res: Response): Promise<string> {
  if (res.status === 429) return "rate_limited";
  if (res.status !== 400) return "failed";
  const body = (await res.json().catch(() => null)) as {
    errors?: { path?: string }[];
  } | null;
  const paths = (body?.errors ?? []).map((e) => e.path ?? "");
  if (paths.some((p) => p.startsWith("timeZone"))) return "timeZone";
  if (paths.some((p) => p.startsWith("locale"))) return "locale";
  return "failed";
}
