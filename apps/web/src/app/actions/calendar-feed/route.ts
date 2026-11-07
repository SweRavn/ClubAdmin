// SPDX-License-Identifier: AGPL-3.0-only
// Creating a calendar subscription or replacing its link (P1.11, ADR 0044):
// the API returns the feed URL once. It reaches /me/calendar in a
// short-lived cookie scoped to that page (never in a URL, which would end up
// in logs and the browser history), like a new invitation's link.

import { isUuid } from "@clubadmin/shared";
import { type NextRequest, type NextResponse } from "next/server";

import { apiFetch } from "../../../server/api.ts";
import { CALENDAR_URL_COOKIE, CSRF_COOKIE, SESSION_COOKIE } from "../../../server/cookies.ts";
import { checkCsrf } from "../../../server/csrf.ts";
import { formText, problem, redirectTo, siteOrigin } from "../../../server/http.ts";
import { freshSession, loadSession } from "../../../server/sessions.ts";

export const dynamic = "force-dynamic";

const PAGE = "/me/calendar";

/** The API call of the posted form, or null if it is not valid. */
function callOf(form: FormData): { path: string; body?: unknown } | null {
  const label = formText(form, "label").trim();
  if (label.length > 60) return null;
  const labelled = label ? { label } : {};
  const target = formText(form, "target");
  if (target === "my_schedule") {
    const everyone = formText(form, "everyone") === "1";
    const personIds = form
      .getAll("personId")
      .filter((v): v is string => typeof v === "string" && isUuid(v));
    if (!everyone && personIds.length === 0) return null;
    return {
      path: "/api/v1/me/calendar-feeds",
      body: { ...labelled, ...(everyone ? {} : { personIds }) },
    };
  }
  const targetId = formText(form, "targetId");
  if (!isUuid(targetId)) return null;
  if (target === "group")
    return { path: `/api/v1/groups/${targetId}/calendar-feeds`, body: labelled };
  if (target === "club")
    return { path: `/api/v1/clubs/${targetId}/calendar-feeds`, body: labelled };
  if (target === "regenerate") return { path: `/api/v1/me/calendar-feeds/${targetId}/regenerate` };
  return null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const form = await request.formData();
  const loaded = await loadSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!loaded) return redirectTo(`/login?returnTo=${encodeURIComponent(PAGE)}`);
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
  if (!session) return redirectTo(`/login?returnTo=${encodeURIComponent(PAGE)}`);
  const call = callOf(form);
  if (!call) return redirectTo(`${PAGE}?error=invalid_input`);

  const res = await apiFetch(call.path, session.record, {
    method: "POST",
    ...(call.body !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(call.body) }
      : {}),
    forwardedFor: request.headers.get("x-forwarded-for"),
  });
  const result = (await res.json().catch(() => null)) as {
    httpsUrl?: string;
    webcalUrl?: string;
    detail?: string;
  } | null;
  if (!res.ok || !result?.httpsUrl || !result.webcalUrl) {
    const detail = typeof result?.detail === "string" && /^[a-z_]+$/.test(result.detail);
    return redirectTo(`${PAGE}?error=${detail ? result.detail! : "failed"}`);
  }
  const response = redirectTo(`${PAGE}?created=1`);
  response.cookies.set(
    CALENDAR_URL_COOKIE,
    JSON.stringify({ httpsUrl: result.httpsUrl, webcalUrl: result.webcalUrl }),
    { httpOnly: true, secure: true, sameSite: "strict", path: PAGE, maxAge: 120 },
  );
  return response;
}
