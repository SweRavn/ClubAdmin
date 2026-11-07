// SPDX-License-Identifier: AGPL-3.0-only
// "Confirm" on a calendar answer link's page (P1.11): POST
// /api/v1/calendar-answers/<token>. No session is needed (the token is signed
// for one feed, activity, person and answer); only same-site forms are accepted.

import { type NextRequest, type NextResponse } from "next/server";

import { apiFetch } from "../../../../server/api.ts";
import { problem, redirectTo, siteOrigin } from "../../../../server/http.ts";

export const dynamic = "force-dynamic";

const TOKEN = /^[A-Za-z0-9_-]{87}$/;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  if (request.headers.get("origin") !== siteOrigin()) return problem("forbidden", "csrf");
  const { token } = await params;
  if (!TOKEN.test(token)) return problem("not-found");
  const res = await apiFetch(`/api/v1/calendar-answers/${token}`, null, {
    method: "POST",
    forwardedFor: request.headers.get("x-forwarded-for"),
  });
  const body = (await res.json().catch(() => null)) as { status?: string; detail?: string } | null;
  if (res.ok && (body?.status === "attending" || body?.status === "not_attending")) {
    return redirectTo(`/answer/${token}?done=${body.status}`);
  }
  const code = res.status === 429 ? "rate_limited" : (body?.detail ?? "failed");
  return redirectTo(`/answer/${token}?error=${encodeURIComponent(code)}`);
}
