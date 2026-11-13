// SPDX-License-Identifier: AGPL-3.0-only
// Downloading a file of the archive (P2.2): the API checks the audience and
// signs a short-lived link on the storage's own domain (an attachment); the
// browser is sent there. `?version=` picks an earlier version.

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
  if (!isUuid(clubId) || !isUuid(documentId)) return problem("not-found");
  const here = `/clubs/${clubId}/documents/${documentId}`;
  const loaded = await loadSession(request.cookies.get(SESSION_COOKIE)?.value);
  const session = loaded ? await freshSession(loaded) : null;
  if (!session) return redirectTo(`/login?returnTo=${encodeURIComponent(here)}`);
  const version = request.nextUrl.searchParams.get("version");
  const path =
    version && isUuid(version)
      ? `/api/v1/clubs/${clubId}/documents/${documentId}/versions/${version}/download`
      : `/api/v1/clubs/${clubId}/documents/${documentId}/download`;
  const res = await apiFetch(path, session.record, {
    onBehalfOf: session.record.viewingAs ?? null,
    forwardedFor: request.headers.get("x-forwarded-for"),
  });
  const body = (await res.json().catch(() => null)) as { url?: unknown; detail?: unknown } | null;
  if (res.ok && typeof body?.url === "string") return redirectTo(body.url, 302);
  if (res.status === 404) return problem("not-found");
  const code =
    typeof body?.detail === "string" && /^[a-z_]+$/.test(body.detail) ? body.detail : "failed";
  return redirectTo(`${here}?error=${code}`);
}
