// SPDX-License-Identifier: AGPL-3.0-only
// Form actions of the joining pages (server/actions.ts): session and CSRF
// check, one API call, then a redirect. Failures go back to the form with
// the problem's detail code (?error=...), which the page translates.

import { type NextRequest, NextResponse } from "next/server";

import { type ApiCall, FORM_ACTIONS } from "../../../server/actions.ts";
import { apiFetch } from "../../../server/api.ts";
import { checkoutOrigins } from "../../../server/config.ts";
import { CSRF_COOKIE, SESSION_COOKIE } from "../../../server/cookies.ts";
import { checkCsrf } from "../../../server/csrf.ts";
import { clearFormDraft, KEEP_VALUES_ACTIONS, saveFormDraft } from "../../../server/form-drafts.ts";
import {
  ENHANCED_HEADER,
  formText,
  problem,
  redirectTo as redirectToPage,
  siteOrigin,
} from "../../../server/http.ts";
import { safeReturnTo } from "../../../server/return-to.ts";
import { freshSession, loadSession } from "../../../server/sessions.ts";

export const dynamic = "force-dynamic";

/**
 * Back to the form with the error's code, and (P2.7c) which form failed
 * (`invalid`, the action's name) with each field's code (`fields`:
 * `name:code;name:code`): the form shows them next to its fields. Codes and
 * field names only, never values.
 */
function withError(
  path: string,
  code: string,
  invalid?: { action: string; fields: Record<string, string> },
): string {
  const url = new URL(path, "https://internal.invalid");
  url.searchParams.set("error", code);
  const fields = Object.entries(invalid?.fields ?? {}).filter(
    ([name, field]) => FIELD_NAME.test(name) && FIELD_CODE.test(field),
  );
  if (invalid && fields.length > 0) {
    url.searchParams.set("invalid", invalid.action);
    url.searchParams.set("fields", fields.map(([n, c]) => `${n}:${c}`).join(";"));
  }
  return `${url.pathname}${url.search}`;
}

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_.]{0,60}$/;
const FIELD_CODE = /^[a-z][a-z_]{0,60}$/;

/**
 * The form fields of the API's validation issues (`errors[].path` of the
 * body: its first segment, through the action's `apiFields`) and of domain
 * codes that are about one field.
 */
function fieldsOfProblem(
  body: unknown,
  code: string,
  apiFields: Record<string, string>,
): Record<string, string> {
  const fields: Record<string, string> = {};
  const issues = (body as { errors?: unknown } | null)?.errors;
  if (Array.isArray(issues)) {
    for (const issue of issues as { location?: string; path?: string; code?: string }[]) {
      if (issue.location !== "body" || typeof issue.path !== "string") continue;
      const first = issue.path.split(/[.[]/)[0] ?? "";
      const name = apiFields[first] ?? first;
      if (name && !(name in fields)) fields[name] = issue.code ?? "invalid";
    }
  }
  const field = DOMAIN_CODE_FIELDS[code];
  const name = field ? (apiFields[field] ?? field) : null;
  if (name) fields[name] = code;
  return fields;
}

/** Domain codes about one request field (the API's name; mapped like the issues). */
const DOMAIN_CODE_FIELDS: Record<string, string> = {
  event_period_invalid: "endsAt",
  respond_by_after_start: "respondBy",
  location_name_taken: "name",
  group_name_taken: "name",
  role_names_required: "names",
};

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
  const enhanced = request.headers.get(ENHANCED_HEADER) === "1";
  // Where to go next: a 303 for a plain form post, JSON for the enhanced form,
  // which updates the page in place or navigates without a reload (ADR 0055).
  const redirectTo = (path: string) =>
    enhanced
      ? NextResponse.json({ redirect: path }, { headers: { "cache-control": "no-store" } })
      : redirectToPage(path);
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
  if (!call || ("invalid" in call && !Array.isArray(call))) {
    if (keepValues) await saveFormDraft(session.id, name, form);
    return redirectTo(
      withError(back, call ? call.invalid : "invalid_input", {
        action: name,
        fields: call?.fields ?? {},
      }),
    );
  }
  // Several calls in order (P2.7c: "Kommer" with a seat in a car): each must
  // succeed; the first that fails stops, and what came before stays done.
  const calls: readonly ApiCall[] = Array.isArray(call) ? call : [call as ApiCall];
  let res: Response | null = null;
  let body: unknown = null;
  for (const one of calls) {
    res = await apiFetch(one.path, session.record, {
      method: one.method,
      ...(one.body !== undefined
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify(one.body) }
        : {}),
      forwardedFor: request.headers.get("x-forwarded-for"),
    });
    body = res.headers.get("content-type")?.includes("json")
      ? await res.json().catch(() => null)
      : null;
    if (!res.ok) break;
  }
  if (!res) return problem("bad-request");
  if (res.ok) {
    if (keepValues) await clearFormDraft(session.id, name);
    // A payment provider's hosted page (P1.13): only to an allowed origin.
    const external = externalRedirect(body);
    if (external) {
      if (enhanced) return NextResponse.json({ external });
      const response = NextResponse.redirect(external, 303);
      response.headers.set("cache-control", "no-store");
      response.headers.set("referrer-policy", "no-referrer");
      return response;
    }
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
  return redirectTo(
    withError(back, code, {
      action: name,
      fields: fieldsOfProblem(body, code, action.apiFields ?? {}),
    }),
  );
}

/**
 * The provider page an action answered with (`redirectUrl`), when its origin
 * is one of BILLING_CHECKOUT_ORIGINS; otherwise null (the action's own page).
 * The same origins are allowed as form targets in the CSP.
 */
function externalRedirect(body: unknown): string | null {
  const url = (body as { redirectUrl?: unknown } | null)?.redirectUrl;
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && checkoutOrigins().includes(parsed.origin) ? url : null;
  } catch {
    return null;
  }
}
