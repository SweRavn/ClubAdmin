// SPDX-License-Identifier: AGPL-3.0-only
// Creating an invitation (P1.1): the API returns the link or code once. It
// reaches the invitations page in a short-lived cookie scoped to that page
// (never in a URL, which would end up in logs and the browser history).

import { isUuid } from "@clubadmin/shared";
import { type NextRequest, type NextResponse } from "next/server";

import { apiFetch } from "../../../server/api.ts";
import { CSRF_COOKIE, INVITATION_SECRET_COOKIE, SESSION_COOKIE } from "../../../server/cookies.ts";
import { checkCsrf } from "../../../server/csrf.ts";
import { formText, problem, redirectTo, siteOrigin } from "../../../server/http.ts";
import { freshSession, loadSession } from "../../../server/sessions.ts";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const form = await request.formData();
  const clubId = formText(form, "clubId");
  if (!isUuid(clubId)) return problem("not-found");
  const page = `/clubs/${clubId}/invitations`;
  const loaded = await loadSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!loaded) return redirectTo(`/login?returnTo=${encodeURIComponent(page)}`);
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
  if (!session) return redirectTo(`/login?returnTo=${encodeURIComponent(page)}`);

  const kind = formText(form, "kind");
  const groupId = formText(form, "groupId");
  const rolePreset = formText(form, "rolePreset");
  const maxUses = Number.parseInt(formText(form, "maxUses"), 10);
  const days = Number.parseInt(formText(form, "expiresInDays"), 10);
  const body = {
    kind,
    ...(kind === "email" ? { email: formText(form, "email").trim() } : {}),
    ...(kind !== "email" && Number.isFinite(maxUses) ? { maxUses } : {}),
    ...(isUuid(groupId) ? { groupId } : {}),
    ...(rolePreset ? { rolePreset } : {}),
    ...(Number.isFinite(days) ? { expiresInDays: days } : {}),
  };
  const res = await apiFetch(`/api/v1/clubs/${clubId}/invitations`, session.record, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    forwardedFor: request.headers.get("x-forwarded-for"),
  });
  const result = (await res.json().catch(() => null)) as {
    url?: string | null;
    code?: string | null;
    detail?: string;
  } | null;
  if (!res.ok) {
    const detail = typeof result?.detail === "string" && /^[a-z_]+$/.test(result.detail);
    return redirectTo(`${page}?error=${detail ? result.detail! : "failed"}`);
  }
  const secret = result?.url ?? result?.code ?? null;
  const response = redirectTo(`${page}?${secret ? "created=1" : "sent=1"}`);
  if (secret) {
    response.cookies.set(INVITATION_SECRET_COOKIE, secret, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: page,
      maxAge: 120,
    });
  }
  return response;
}
