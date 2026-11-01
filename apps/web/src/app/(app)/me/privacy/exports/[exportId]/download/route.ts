// SPDX-License-Identifier: AGPL-3.0-only
// Downloading my data (P1.8b): asks the API for a pre-signed link (valid
// five minutes, the requester only, with a recent login) and redirects the
// browser to it. Failures go back to the privacy page with the problem's
// detail code (reauthentication_required when the login is not recent).

import { isUuid } from "@clubadmin/shared";
import { type NextRequest, NextResponse } from "next/server";

import { apiFetch } from "../../../../../../../server/api.ts";
import { SESSION_COOKIE } from "../../../../../../../server/cookies.ts";
import { redirectTo } from "../../../../../../../server/http.ts";
import { freshSession, loadSession } from "../../../../../../../server/sessions.ts";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ exportId: string }> },
): Promise<NextResponse> {
  const { exportId } = await params;
  const back = "/me/privacy";
  if (!isUuid(exportId)) return redirectTo(back);
  const loaded = await loadSession(request.cookies.get(SESSION_COOKIE)?.value);
  const session = loaded ? await freshSession(loaded) : null;
  if (!session) return redirectTo(`/login?returnTo=${encodeURIComponent(back)}`);
  const res = await apiFetch(`/api/v1/me/data-exports/${exportId}/download`, session.record, {
    forwardedFor: request.headers.get("x-forwarded-for"),
  });
  const body = (await res.json().catch(() => null)) as {
    url?: unknown;
    detail?: unknown;
    type?: unknown;
  } | null;
  if (res.ok && typeof body?.url === "string" && /^https?:\/\//.test(body.url)) {
    const response = NextResponse.redirect(body.url, 303);
    response.headers.set("cache-control", "no-store");
    response.headers.set("referrer-policy", "no-referrer");
    return response;
  }
  const code =
    res.status === 403 &&
    typeof body?.type === "string" &&
    body.type.endsWith("#reauthentication-required")
      ? "reauthentication_required"
      : typeof body?.detail === "string" && /^[a-z_]+$/.test(body.detail)
        ? body.detail
        : "failed";
  return redirectTo(`${back}?error=${code}#exports`);
}
