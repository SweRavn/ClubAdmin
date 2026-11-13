// SPDX-License-Identifier: AGPL-3.0-only
// Uploading to the file archive (P2.2, ADR 0049): the form posts the file
// here (session and CSRF checked, at most 25 MB) with its target: a folder
// (a new file), a file (a new version), or an activity's or event's notice.
// The server starts the upload in the API, puts the file to the pre-signed
// link and tells the API it is uploaded; the worker then scans it. The
// browser never talks to the storage, so the pages work without client
// JavaScript. Failures go back with the problem's detail code.

import { DOCUMENT_MAX_BYTES, documentContentType, isUuid } from "@clubadmin/shared";
import { type NextRequest, type NextResponse } from "next/server";

import { apiFetch } from "../../../../../../server/api.ts";
import { CSRF_COOKIE, SESSION_COOKIE } from "../../../../../../server/cookies.ts";
import { checkCsrf } from "../../../../../../server/csrf.ts";
import { formText, problem, redirectTo, siteOrigin } from "../../../../../../server/http.ts";
import { safeReturnTo } from "../../../../../../server/return-to.ts";
import { freshSession, loadSession } from "../../../../../../server/sessions.ts";

export const dynamic = "force-dynamic";

const codeOf = (body: unknown, status: number): string => {
  const detail = (body as { detail?: unknown } | null)?.detail;
  const type = (body as { type?: string } | null)?.type ?? "";
  if (status === 403 && type.endsWith("#mfa-required")) return "mfa_required";
  return typeof detail === "string" && /^[a-z_]+$/.test(detail) ? detail : "failed";
};

const withParam = (path: string, key: string, value: string) =>
  `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`;

/** Where the upload starts in the API, per target. */
function startPath(clubId: string, target: string, targetId: string): string | null {
  switch (target) {
    case "folder":
      return `/api/v1/clubs/${clubId}/folders/${targetId}/uploads`;
    case "document":
      return `/api/v1/clubs/${clubId}/documents/${targetId}/versions`;
    case "activity":
      return `/api/v1/activities/${targetId}/attachments/uploads`;
    case "event":
      return `/api/v1/events/${targetId}/attachments/uploads`;
    default:
      return null;
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ clubId: string }> },
): Promise<NextResponse> {
  const { clubId } = await params;
  if (!isUuid(clubId)) return problem("not-found");
  const form = await request.formData();
  const back = safeReturnTo(formText(form, "back"), `/clubs/${clubId}/documents`);
  const fail = (code: string) => redirectTo(withParam(back, "error", code));
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
  const targetId = formText(form, "targetId");
  const path = isUuid(targetId) ? startPath(clubId, formText(form, "target"), targetId) : null;
  const file = form.get("file");
  if (!path || !(file instanceof File) || file.size === 0) return fail("invalid_input");
  if (file.size > DOCUMENT_MAX_BYTES) return fail("document_too_large");
  const contentType = documentContentType(file.name);
  if (!contentType) return fail("document_type_not_allowed");
  const name = formText(form, "name").slice(0, 200);
  const forwardedFor = request.headers.get("x-forwarded-for");

  const started = await apiFetch(path, session.record, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      fileName: file.name.slice(0, 200),
      size: file.size,
      ...(name ? { name } : {}),
      ...(formText(form, "notify") === "true" ? { notify: true } : {}),
    }),
    forwardedFor,
  });
  const body = (await started.json().catch(() => null)) as {
    documentId?: unknown;
    versionId?: unknown;
    uploadUrl?: unknown;
  } | null;
  const { documentId, versionId, uploadUrl } = body ?? {};
  if (
    !started.ok ||
    typeof documentId !== "string" ||
    typeof versionId !== "string" ||
    typeof uploadUrl !== "string"
  ) {
    return fail(codeOf(body, started.status));
  }
  // The storage unreachable is a failed upload, never an error page.
  const put = await fetch(uploadUrl, {
    method: "PUT",
    // fetch sends the buffer's length as content-length (signed in the link).
    headers: { "content-type": contentType },
    body: Buffer.from(await file.arrayBuffer()),
  }).catch(() => null);
  await put?.body?.cancel();
  if (!put?.ok) return fail("document_upload_failed");
  const uploaded = await apiFetch(
    `/api/v1/clubs/${clubId}/documents/${documentId}/versions/${versionId}/uploaded`,
    session.record,
    { method: "POST", forwardedFor },
  );
  if (!uploaded.ok) return fail(codeOf(await uploaded.json().catch(() => null), uploaded.status));
  return redirectTo(withParam(back, "uploaded", "1"));
}
