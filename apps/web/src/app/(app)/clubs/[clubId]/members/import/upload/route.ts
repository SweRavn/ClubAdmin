// SPDX-License-Identifier: AGPL-3.0-only
// Uploading a member import file (P1.3b): the form posts the CSV file here
// (session and CSRF checked, at most 10 MB); the server starts the import,
// puts the file to the pre-signed upload link the API returned (ADR 0011)
// and tells the API it is uploaded. The browser never talks to the storage,
// so the page works without client JavaScript. Failures go back with the
// problem's detail code.

import { isUuid, MEMBER_IMPORT_MAX_BYTES } from "@clubadmin/shared";
import { type NextRequest, type NextResponse } from "next/server";

import { apiFetch } from "../../../../../../../server/api.ts";
import { CSRF_COOKIE, SESSION_COOKIE } from "../../../../../../../server/cookies.ts";
import { checkCsrf } from "../../../../../../../server/csrf.ts";
import { formText, problem, redirectTo, siteOrigin } from "../../../../../../../server/http.ts";
import { freshSession, loadSession } from "../../../../../../../server/sessions.ts";

export const dynamic = "force-dynamic";

const codeOf = (body: unknown, status: number): string => {
  const detail = (body as { detail?: unknown } | null)?.detail;
  const type = (body as { type?: string } | null)?.type ?? "";
  if (status === 403 && type.endsWith("#mfa-required")) return "mfa_required";
  return typeof detail === "string" && /^[a-z_]+$/.test(detail) ? detail : "failed";
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ clubId: string }> },
): Promise<NextResponse> {
  const { clubId } = await params;
  if (!isUuid(clubId)) return problem("not-found");
  const back = `/clubs/${clubId}/members/import`;
  const fail = (code: string) => redirectTo(`${back}?error=${code}`);
  const form = await request.formData();
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
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return fail("invalid_input");
  if (file.size > MEMBER_IMPORT_MAX_BYTES) return fail("import_file_too_large");
  if (!/\.(csv|txt)$/i.test(file.name)) return fail("import_format_unsupported");
  const forwardedFor = request.headers.get("x-forwarded-for");

  const started = await apiFetch(`/api/v1/clubs/${clubId}/member-imports`, session.record, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ format: "csv", size: file.size }),
    forwardedFor,
  });
  const body = (await started.json().catch(() => null)) as {
    import?: { id?: unknown };
    uploadUrl?: unknown;
  } | null;
  const importId = body?.import?.id;
  if (!started.ok || typeof importId !== "string" || typeof body?.uploadUrl !== "string") {
    return fail(codeOf(body, started.status));
  }
  const put = await fetch(body.uploadUrl, {
    method: "PUT",
    // fetch sends the buffer's length as content-length (signed in the link).
    headers: { "content-type": "text/csv" },
    body: Buffer.from(await file.arrayBuffer()),
  });
  await put.body?.cancel();
  if (!put.ok) return fail("import_upload_failed");
  const uploaded = await apiFetch(
    `/api/v1/clubs/${clubId}/member-imports/${importId}/uploaded`,
    session.record,
    { method: "POST", forwardedFor },
  );
  if (!uploaded.ok) {
    return fail(codeOf(await uploaded.json().catch(() => null), uploaded.status));
  }
  return redirectTo(`${back}?import=${importId}`);
}
