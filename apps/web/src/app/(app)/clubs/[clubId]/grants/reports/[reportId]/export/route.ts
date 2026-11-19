// SPDX-License-Identifier: AGPL-3.0-only
// Exporting a locked grant report (P2.7 part C): a form POST (CSRF checked,
// as the export is audited and marks the report exported) asks the API for
// the plugin's files and sends the first one as a download. A plugin with
// several files for one format returns them one per format today (LOK: one
// CSV or one PDF). Failures go back to the report with the problem's code.

import { GrantFilesSchema, isUuid } from "@clubadmin/shared";
import { type NextRequest, NextResponse } from "next/server";

import { apiFetch } from "../../../../../../../../server/api.ts";
import { CSRF_COOKIE, SESSION_COOKIE } from "../../../../../../../../server/cookies.ts";
import { checkCsrf } from "../../../../../../../../server/csrf.ts";
import { formText, problem, redirectTo, siteOrigin } from "../../../../../../../../server/http.ts";
import { safeReturnTo } from "../../../../../../../../server/return-to.ts";
import { freshSession, loadSession } from "../../../../../../../../server/sessions.ts";

export const dynamic = "force-dynamic";

const FORMATS = ["csv", "pdf", "xml", "json"] as const;

/** A file name safe for Content-Disposition (the plugin's name, ASCII only). */
const safeName = (name: string) => name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "export";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ clubId: string; reportId: string }> },
): Promise<NextResponse> {
  const { clubId, reportId } = await params;
  if (!isUuid(clubId) || !isUuid(reportId)) return redirectTo("/");
  const form = await request.formData();
  const back = safeReturnTo(formText(form, "back"));
  const loaded = await loadSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!loaded) return redirectTo(`/login?returnTo=${encodeURIComponent(back)}`);
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
  if (!session) return redirectTo(`/login?returnTo=${encodeURIComponent(back)}`);
  const format = FORMATS.find((f) => f === formText(form, "format"));
  const withError = (code: string) =>
    redirectTo(`${back}${back.includes("?") ? "&" : "?"}error=${code}`);
  if (!format) return withError("invalid_input");
  const res = await apiFetch(
    `/api/v1/clubs/${clubId}/grants/reports/${reportId}/export`,
    session.record,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ format }),
      forwardedFor: request.headers.get("x-forwarded-for"),
    },
  );
  const body: unknown = await res.json().catch(() => null);
  const parsed = res.ok ? GrantFilesSchema.safeParse(body) : null;
  const file = parsed?.success ? parsed.data.files[0] : undefined;
  if (!file) {
    const detail = (body as { detail?: unknown } | null)?.detail;
    return withError(
      typeof detail === "string" && /^[a-z_]+$/.test(detail) ? detail : "grant_export_empty",
    );
  }
  return new NextResponse(Buffer.from(file.content, "base64"), {
    status: 200,
    headers: {
      "content-type": /^[a-z]+\/[a-z0-9.+-]+$/.test(file.mediaType)
        ? file.mediaType
        : "application/octet-stream",
      "content-disposition": `attachment; filename="${safeName(file.name)}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
