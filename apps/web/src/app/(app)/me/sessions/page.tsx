// SPDX-License-Identifier: AGPL-3.0-only
// The person's browser sessions; any other one can be logged out.

import { formatDateTime } from "@clubadmin/ui";
import { getLocale, getTimeZone, getTranslations } from "next-intl/server";

import { getSessions, requireSession } from "../../../../server/data.ts";

export async function generateMetadata() {
  return { title: (await getTranslations())("sessions.title") };
}

export default async function SessionsPage() {
  const [t, locale, timeZone, session, { sessions }] = await Promise.all([
    getTranslations(),
    getLocale(),
    getTimeZone(),
    requireSession(),
    getSessions(),
  ]);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{t("sessions.title")}</h1>
      {sessions.length === 0 ? <p className="text-muted">{t("sessions.empty")}</p> : null}
      <ul
        data-testid="sessions"
        className="divide-y divide-border rounded-lg border border-border bg-raised"
      >
        {sessions.map((s) => (
          <li
            key={s.id}
            data-session-id={s.id}
            className="flex flex-wrap items-center gap-3 px-4 py-3"
          >
            <span className="font-medium">{s.device}</span>
            <span className="text-sm text-muted">
              {t("sessions.lastSeen", { time: formatDateTime(s.lastSeenAt, { locale, timeZone }) })}
            </span>
            {s.id === session.record.handle ? (
              <strong className="ml-auto text-sm">{t("sessions.current")}</strong>
            ) : (
              <form
                method="post"
                action={`/me/sessions/${encodeURIComponent(s.id)}/revoke`}
                className="ml-auto"
              >
                <input type="hidden" name="csrf" value={session.record.csrf} />
                <button type="submit" className="rounded-md border border-border px-3 py-1 text-sm">
                  {t("sessions.revoke")}
                </button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
