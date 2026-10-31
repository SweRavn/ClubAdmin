// SPDX-License-Identifier: AGPL-3.0-only
// The button of the unsubscribe page (P1.7): POST /api/v1/notifications/unsubscribe
// with the link's token. No session is needed (the token is signed for one
// account and category); only same-site forms are accepted.

import { type NextRequest, type NextResponse } from "next/server";

import { apiFetch } from "../../../server/api.ts";
import { formText, problem, redirectTo, siteOrigin } from "../../../server/http.ts";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (request.headers.get("origin") !== siteOrigin()) return problem("forbidden", "csrf");
  const form = await request.formData();
  const token = formText(form, "token").trim();
  const res = await apiFetch("/api/v1/notifications/unsubscribe", null, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
    forwardedFor: request.headers.get("x-forwarded-for"),
  });
  const body = (await res.json().catch(() => null)) as {
    category?: string;
    detail?: string;
  } | null;
  if (res.ok && body?.category) {
    return redirectTo(`/unsubscribe?done=${encodeURIComponent(body.category)}`);
  }
  const code = res.status === 429 ? "rate_limited" : (body?.detail ?? "failed");
  return redirectTo(
    `/unsubscribe?token=${encodeURIComponent(token)}&error=${encodeURIComponent(code)}`,
  );
}
