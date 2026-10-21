// SPDX-License-Identifier: AGPL-3.0-only
// Protected test page: the logged-in person (via the API, so through the
// person presenter) and the browser sessions, with logout. The real account
// pages come in P0.9.

import { MeResponseSchema, SessionListSchema } from "@clubadmin/shared";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { apiFetch } from "../../server/api.ts";
import { CSRF_COOKIE, SESSION_COOKIE } from "../../server/cookies.ts";
import { freshSession, loadSession } from "../../server/sessions.ts";
import { translator } from "../i18n.ts";

export const dynamic = "force-dynamic";

export default async function MePage() {
  const jar = await cookies();
  const loaded = await loadSession(jar.get(SESSION_COOKIE)?.value);
  const session = loaded ? await freshSession(loaded) : null;
  if (!session) redirect("/auth/login?returnTo=%2Fme");

  const [meRes, sessionsRes] = await Promise.all([
    apiFetch("/api/v1/me", session.record),
    apiFetch("/api/v1/me/sessions", session.record),
  ]);
  if (meRes.status === 401) redirect("/auth/login?returnTo=%2Fme");
  const me = MeResponseSchema.parse(await meRes.json());
  const sessions = sessionsRes.ok ? SessionListSchema.parse(await sessionsRes.json()).sessions : [];
  const csrf = jar.get(CSRF_COOKIE)?.value ?? "";
  const { locale, t } = await translator();
  const time = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });

  return (
    <main>
      {session.record.devAuth && (
        <p
          role="status"
          style={{ background: "#fff3cd", padding: "0.5rem" }}
          data-testid="dev-banner"
        >
          {t("web.devBanner", { name: me.person.displayName })}
        </p>
      )}
      <h1>{t("web.me.title")}</h1>
      <p data-testid="me-name">{t("web.me.loggedInAs", { name: me.person.displayName })}</p>
      <p data-testid="me-mfa">{me.mfa ? t("web.me.mfa.on") : t("web.me.mfa.off")}</p>

      <h2>{t("web.me.sessions")}</h2>
      <ul data-testid="sessions">
        {sessions.map((s) => (
          <li key={s.id} data-session-id={s.id}>
            {s.device} ·{" "}
            {t("web.me.sessions.lastSeen", { time: time.format(new Date(s.lastSeenAt)) })}
            {s.id === session.record.handle ? (
              <strong> · {t("web.me.sessions.current")}</strong>
            ) : (
              <form
                method="post"
                action={`/me/sessions/${encodeURIComponent(s.id)}/revoke`}
                style={{ display: "inline" }}
              >
                <input type="hidden" name="csrf" value={csrf} />{" "}
                <button type="submit">{t("web.me.sessions.revoke")}</button>
              </form>
            )}
          </li>
        ))}
      </ul>

      <form method="post" action="/auth/logout">
        <input type="hidden" name="csrf" value={csrf} />
        <button type="submit" data-testid="logout">
          {t("web.logout")}
        </button>
      </form>
    </main>
  );
}
