// SPDX-License-Identifier: AGPL-3.0-only
// "Viewing as": a guardian switches to acting for a ward (or back). Stored in
// the session; the BFF then sends X-On-Behalf-Of on the ward's behalf, and
// the API checks the act_on_behalf right on every request (ADR 0006).

import { MyWardsSchema } from "@clubadmin/shared";
import { type NextRequest, type NextResponse } from "next/server";

import { apiFetch } from "../../../server/api.ts";
import { CSRF_COOKIE, SESSION_COOKIE } from "../../../server/cookies.ts";
import { checkCsrf } from "../../../server/csrf.ts";
import { formText, problem, redirectTo, siteOrigin } from "../../../server/http.ts";
import { safeReturnTo } from "../../../server/return-to.ts";
import { freshSession, loadSession, sessionStore } from "../../../server/sessions.ts";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const loaded = await loadSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!loaded) return redirectTo("/login");
  const form = await request.formData();
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
  if (!session) return redirectTo("/login");

  const personId = formText(form, "personId");
  let viewingAs: string | null = null;
  if (personId) {
    const res = await apiFetch("/api/v1/me/wards", session.record);
    const wards = res.ok ? MyWardsSchema.parse(await res.json()).wards : [];
    const ward = wards.find((w) => w.person.id === personId && w.rights.includes("act_on_behalf"));
    if (!ward) return problem("forbidden", "not_guardian_with_act_on_behalf");
    viewingAs = ward.person.id;
  }
  await sessionStore().update(session.id, { ...session.record, viewingAs });
  // The page the switch was made on may not exist for the other person: start at home.
  const back = safeReturnTo(formText(form, "returnTo"));
  return redirectTo(viewingAs || back.startsWith("/me") ? "/" : back);
}
