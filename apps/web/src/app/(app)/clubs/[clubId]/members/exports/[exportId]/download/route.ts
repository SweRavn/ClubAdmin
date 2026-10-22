// SPDX-License-Identifier: AGPL-3.0-only
// Downloading a member register export (P1.2): asks the API for a pre-signed
// link (valid 5 minutes, the requester only) and redirects the browser to it.
// Failures go back to the exports page with the problem's detail code.

import { isUuid } from "@clubadmin/shared";
import { type NextRequest, NextResponse } from "next/server";

import { apiFetch } from "../../../../../../../../server/api.ts";
import { SESSION_COOKIE } from "../../../../../../../../server/cookies.ts";
import { redirectTo } from "../../../../../../../../server/http.ts";
import { freshSession, loadSession } from "../../../../../../../../server/sessions.ts";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ clubId: string; exportId: string }> },
): Promise<NextResponse> {
  const { clubId, exportId } = await params;
  if (!isUuid(clubId) || !isUuid(exportId)) return redirectTo("/");
  const back = `/clubs/${clubId}/members/exports`;
  const loaded = await loadSession(request.cookies.get(SESSION_COOKIE)?.value);
  const session = loaded ? await freshSession(loaded) : null;
  if (!session) return redirectTo(`/login?returnTo=${encodeURIComponent(back)}`);
  const res = await apiFetch(
    `/api/v1/clubs/${clubId}/member-exports/${exportId}/download`,
    session.record,
    { forwardedFor: request.headers.get("x-forwarded-for") },
  );
  const body = (await res.json().catch(() => null)) as { url?: unknown; detail?: unknown } | null;
  if (res.ok && typeof body?.url === "string" && /^https?:\/\//.test(body.url)) {
    const response = NextResponse.redirect(body.url, 303);
    response.headers.set("cache-control", "no-store");
    response.headers.set("referrer-policy", "no-referrer");
    return response;
  }
  const code =
    typeof body?.detail === "string" && /^[a-z_]+$/.test(body.detail) ? body.detail : "failed";
  return redirectTo(`${back}?error=${code}`);
}
