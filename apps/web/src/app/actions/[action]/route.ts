// SPDX-License-Identifier: AGPL-3.0-only
// Form actions of the joining pages (server/actions.ts): session and CSRF
// check, one API call, then a redirect. Failures go back to the form with
// the problem's detail code (?error=...), which the page translates.

import { type NextRequest, type NextResponse } from "next/server";

import { FORM_ACTIONS } from "../../../server/actions.ts";
import { apiFetch } from "../../../server/api.ts";
import { CSRF_COOKIE, SESSION_COOKIE } from "../../../server/cookies.ts";
import { checkCsrf } from "../../../server/csrf.ts";
import { clearFormDraft, KEEP_VALUES_ACTIONS, saveFormDraft } from "../../../server/form-drafts.ts";
import { formText, problem, redirectTo, siteOrigin } from "../../../server/http.ts";
import { safeReturnTo } from "../../../server/return-to.ts";
import { freshSession, loadSession } from "../../../server/sessions.ts";

export const dynamic = "force-dynamic";

const withError = (path: string, code: string) =>
  `${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(code)}`;

/** One more row of a list (`more` = its query parameter, e.g. "qrows"), counted from the form. */
function withMoreRows(path: string, form: FormData): string {
  const more = formText(form, "more");
  if (!/^[a-z]{1,10}rows$/.test(more)) return path;
  const url = new URL(path, "https://internal.invalid");
  const current = Number(formText(form, more) || "1");
  url.searchParams.set(more, String(Math.min((Number.isFinite(current) ? current : 1) + 1, 50)));
  return `${url.pathname}${url.search}`;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ action: string }> },
): Promise<NextResponse> {
  const name = (await params).action;
  const action = FORM_ACTIONS[name];
  if (!action) return problem("not-found");
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
  const keepValues = KEEP_VALUES_ACTIONS.has(name);
  // "Add a row" without JavaScript (P1.6b): nothing is saved; the form comes
  // back with what was typed and one more row.
  if (keepValues && formText(form, "more")) {
    await saveFormDraft(session.id, name, form);
    return redirectTo(
      safeReturnTo(withMoreRows(`${back}${back.includes("?") ? "&" : "?"}draft=1`, form)),
    );
  }
  const call = action.call(form);
  if (!call) {
    if (keepValues) await saveFormDraft(session.id, name, form);
    return redirectTo(withError(back, "invalid_input"));
  }
  const res = await apiFetch(call.path, session.record, {
    method: call.method,
    ...(call.body !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(call.body) }
      : {}),
    forwardedFor: request.headers.get("x-forwarded-for"),
  });
  const body: unknown = res.headers.get("content-type")?.includes("json")
    ? await res.json().catch(() => null)
    : null;
  if (res.ok) {
    if (keepValues) await clearFormDraft(session.id, name);
    return redirectTo(safeReturnTo(action.done(form, body)));
  }
  const detail = (body as { detail?: unknown } | null)?.detail;
  const type = (body as { type?: string } | null)?.type ?? "";
  const code =
    res.status === 403 && type.endsWith("#mfa-required")
      ? "mfa_required"
      : res.status === 403 && type.endsWith("#reauthentication-required")
        ? "reauthentication_required"
        : typeof detail === "string" && /^[a-z_]+$/.test(detail)
          ? detail
          : res.status === 429
            ? "rate_limited"
            : "failed";
  if (keepValues) await saveFormDraft(session.id, name, form);
  return redirectTo(withError(back, code));
}
