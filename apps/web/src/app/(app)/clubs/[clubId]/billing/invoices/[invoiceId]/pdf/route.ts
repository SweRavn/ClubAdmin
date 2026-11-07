// SPDX-License-Identifier: AGPL-3.0-only
// Downloading an invoice PDF (P1.13): asks the API for a pre-signed link
// (valid five minutes) and redirects the browser to it. Failures go back to
// the billing page with the problem's detail code.

import { isUuid } from "@clubadmin/shared";
import { type NextRequest, NextResponse } from "next/server";

import { apiFetch } from "../../../../../../../../server/api.ts";
import { SESSION_COOKIE } from "../../../../../../../../server/cookies.ts";
import { redirectTo } from "../../../../../../../../server/http.ts";
import { freshSession, loadSession } from "../../../../../../../../server/sessions.ts";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ clubId: string; invoiceId: string }> },
): Promise<NextResponse> {
  const { clubId, invoiceId } = await params;
  if (!isUuid(clubId) || !isUuid(invoiceId)) return redirectTo("/");
  const back = `/clubs/${clubId}/billing`;
  const loaded = await loadSession(request.cookies.get(SESSION_COOKIE)?.value);
  const session = loaded ? await freshSession(loaded) : null;
  if (!session) return redirectTo(`/login?returnTo=${encodeURIComponent(back)}`);
  const res = await apiFetch(`/api/v1/clubs/${clubId}/invoices/${invoiceId}/pdf`, session.record, {
    forwardedFor: request.headers.get("x-forwarded-for"),
  });
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
