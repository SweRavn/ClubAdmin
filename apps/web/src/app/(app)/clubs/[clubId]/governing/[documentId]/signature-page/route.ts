// SPDX-License-Identifier: AGPL-3.0-only
// A governing document's signature page (P2.4): the API checks the
// audience and signs a short-lived link to the PDF; the browser is sent
// there. `?version=` names the signed version.

import { isUuid } from "@clubadmin/shared";
import { type NextRequest, type NextResponse } from "next/server";

import { apiFetch } from "../../../../../../../server/api.ts";
import { SESSION_COOKIE } from "../../../../../../../server/cookies.ts";
import { problem, redirectTo } from "../../../../../../../server/http.ts";
import { freshSession, loadSession } from "../../../../../../../server/sessions.ts";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ clubId: string; documentId: string }> },
): Promise<NextResponse> {
  const { clubId, documentId } = await params;
  const version = request.nextUrl.searchParams.get("version");
  if (!isUuid(clubId) || !isUuid(documentId) || !version || !isUuid(version)) {
    return problem("not-found");
  }
  const here = `/clubs/${clubId}/governing/${documentId}`;
  const loaded = await loadSession(request.cookies.get(SESSION_COOKIE)?.value);
  const session = loaded ? await freshSession(loaded) : null;
  if (!session) return redirectTo(`/login?returnTo=${encodeURIComponent(here)}`);
  const res = await apiFetch(
    `/api/v1/clubs/${clubId}/documents/${documentId}/versions/${version}/signature-page`,
    session.record,
    {
      onBehalfOf: session.record.viewingAs ?? null,
      forwardedFor: request.headers.get("x-forwarded-for"),
    },
  );
  const body = (await res.json().catch(() => null)) as { url?: unknown; detail?: unknown } | null;
  if (res.ok && typeof body?.url === "string") return redirectTo(body.url, 302);
  if (res.status === 404) return problem("not-found");
  const code =
    typeof body?.detail === "string" && /^[a-z_]+$/.test(body.detail) ? body.detail : "failed";
  return redirectTo(`${here}?error=${code}`);
}
