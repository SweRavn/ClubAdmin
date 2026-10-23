// SPDX-License-Identifier: AGPL-3.0-only
// A group's attendance over a period (P1.5): each member's sessions,
// present / absent / excused and rate, and per session the number present
// with the LOK-stöd hints. For leaders, owners, club managers and
// registrars. The period defaults to the last 90 days.
import { enumKey } from "@clubadmin/i18n";
import { PersonName } from "@clubadmin/ui";
import { getTranslations } from "next-intl/server";

import { buttonClass, inputClass } from "../../../../../components/action-form.tsx";
import { ClubTime } from "../../../../../components/club-time.tsx";
import { getGroup, getGroupAttendance, requireId } from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ groupId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const DAY = 86_400_000;
const isDate = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

export async function generateMetadata() {
  return { title: (await getTranslations())("attendance.summary") };
}

export default async function GroupAttendancePage({ params, searchParams }: Props) {
  const [{ groupId }, query] = await Promise.all([params, searchParams]);
  const now = Date.now();
  const fromDay = isDate(query.from)
    ? query.from
    : new Date(now - 90 * DAY).toISOString().slice(0, 10);
  const toDay = isDate(query.to) ? query.to : new Date(now).toISOString().slice(0, 10);
  const cursor = typeof query.cursor === "string" ? requireId(query.cursor) : null;
  const [t, group, summary] = await Promise.all([
    getTranslations(),
    getGroup(groupId),
    getGroupAttendance(
      groupId,
      `${fromDay}T00:00:00Z`,
      new Date(Date.parse(`${toDay}T00:00:00Z`) + DAY).toISOString(),
      cursor,
    ),
  ]);
  const protectedLabel = t("protected.tooltip");
  const percent = (rate: number | null) => (rate === null ? "–" : `${Math.round(rate * 100)} %`);

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">
        <a href={`/groups/${group.id}`} className="underline">
          {group.name}
        </a>
      </p>
      <h1 className="text-2xl font-semibold">{t("attendance.summary")}</h1>
      <form
        method="get"
        className="flex flex-wrap items-end gap-3"
        aria-label={t("attendance.period")}
      >
        <label className="space-y-1">
          <span className="block text-sm">{t("attendance.from")}</span>
          <input type="date" name="from" defaultValue={fromDay} className={inputClass} />
        </label>
        <label className="space-y-1">
          <span className="block text-sm">{t("attendance.to")}</span>
          <input type="date" name="to" defaultValue={toDay} className={inputClass} />
        </label>
        <button type="submit" className={buttonClass}>
          {t("attendance.show")}
        </button>
      </form>

      <section aria-labelledby="attendance-members" className="space-y-2">
        <h2 id="attendance-members" className="text-lg font-semibold">
          {t("attendance.member")}
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="attendance-members">
            <thead className="text-left text-muted">
              <tr>
                <th className="py-1 pr-3">{t("attendance.member")}</th>
                <th className="py-1 pr-3 text-right">{t("attendance.sessions")}</th>
                <th className="py-1 pr-3 text-right">{t("attendance.present")}</th>
                <th className="py-1 pr-3 text-right">{t("attendance.absent")}</th>
                <th className="py-1 pr-3 text-right">{t("attendance.excused")}</th>
                <th className="py-1 text-right">{t("attendance.rate")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {summary.members.map((m) => (
                <tr key={m.person.id}>
                  <td className="py-1 pr-3">
                    <PersonName person={m.person} protectedLabel={protectedLabel} />
                  </td>
                  <td className="py-1 pr-3 text-right tabular-nums">{m.sessions}</td>
                  <td className="py-1 pr-3 text-right tabular-nums">{m.present}</td>
                  <td className="py-1 pr-3 text-right tabular-nums">{m.absent}</td>
                  <td className="py-1 pr-3 text-right tabular-nums">{m.excused}</td>
                  <td className="py-1 text-right tabular-nums">{percent(m.rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {summary.nextCursor ? (
          <a
            href={`/groups/${group.id}/attendance?from=${fromDay}&to=${toDay}&cursor=${summary.nextCursor}`}
            className="text-sm underline"
          >
            {t("schedule.later")}
          </a>
        ) : null}
      </section>

      <section aria-labelledby="attendance-sessions" className="space-y-2">
        <h2 id="attendance-sessions" className="text-lg font-semibold">
          {t("attendance.sessions")}
        </h2>
        {summary.sessions.length === 0 ? (
          <p className="text-muted">{t("attendance.noSessions")}</p>
        ) : (
          <ul
            className="divide-y divide-border rounded-lg border border-border bg-raised"
            data-testid="attendance-sessions"
          >
            {summary.sessions.map((s) => (
              <li key={s.activityId} className="px-3 py-2">
                <a
                  href={`/activities/${s.activityId}/attendance`}
                  className="font-medium text-accent underline"
                >
                  {s.title}
                </a>{" "}
                <span className="text-sm text-muted">
                  <ClubTime
                    value={s.startsAt}
                    timeZone={summary.timeZone}
                    dateStyle="medium"
                    timeStyle="short"
                  />
                  {" · "}
                  {s.recorded
                    ? t("attendance.presentCount", {
                        present: s.present,
                        leaders: s.leadersPresent,
                      })
                    : t("attendance.notRecorded")}
                </span>
                {s.hints.map((h) => (
                  <span key={h.code} className="block text-xs">
                    {t(enumKey("grantHints.lok", h.code))}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
