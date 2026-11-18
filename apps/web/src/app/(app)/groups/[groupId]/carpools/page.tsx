// SPDX-License-Identifier: AGPL-3.0-only
// A group's car-pool statistics (P2.5, ADR 0048): drives, distance and
// passengers per person for a period. Leaders and attesters see everyone;
// members see their own and their children's unless the group's leaders
// made the statistics public in the group (the setting is here too).
import { personLabel } from "@clubadmin/ui";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { ActionForm, buttonClass, inputClass } from "../../../../../components/action-form.tsx";
import { FormError, Notice } from "../../../../../components/form-error.tsx";
import {
  getCarpoolStats,
  getGroup,
  getGroupCalendarIfAllowed,
} from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ groupId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

export async function generateMetadata() {
  return { title: (await getTranslations())("carpool.stats") };
}

export default async function GroupCarpoolStatsPage({ params, searchParams }: Props) {
  const [{ groupId }, query] = await Promise.all([params, searchParams]);
  const today = new Date().toISOString().slice(0, 10);
  const from = isDate(query.from) ? query.from : `${today.slice(0, 4)}-01-01`;
  const to = isDate(query.to) ? query.to : today;
  const [t, group] = await Promise.all([getTranslations(), getGroup(groupId)]);
  const [stats, calendar] = await Promise.all([
    getCarpoolStats(group.clubId, group.id, from, to),
    getGroupCalendarIfAllowed(group.id, `${today}T00:00:00Z`, `${today}T00:00:01Z`),
  ]);
  if (!stats) notFound();
  const back = `/groups/${group.id}/carpools?from=${from}&to=${to}`;
  return (
    <div className="space-y-6">
      <p className="text-sm">
        <a href={`/groups/${group.id}`} className="underline">
          {group.name}
        </a>
      </p>
      <h1 className="text-2xl font-semibold">{t("carpool.stats")}</h1>
      <FormError code={query.error} />
      {query.saved ? <Notice>{t("carpool.saved")}</Notice> : null}
      <form method="get" className="flex flex-wrap items-end gap-3">
        <label className="block space-y-1">
          <span className="text-sm">{t("expenses.from")}</span>
          <input type="date" name="from" defaultValue={from} className={inputClass} />
        </label>
        <label className="block space-y-1">
          <span className="text-sm">{t("expenses.to")}</span>
          <input type="date" name="to" defaultValue={to} className={inputClass} />
        </label>
        <button type="submit" className={buttonClass}>
          {t("carpool.show")}
        </button>
      </form>
      {stats.rows.length === 0 ? (
        <p className="text-muted" data-testid="stats-empty">
          {t("carpool.statsEmpty")}
        </p>
      ) : (
        <table className="w-full text-sm" data-testid="carpool-stats">
          <thead>
            <tr className="text-left text-muted">
              <th className="py-1 pr-3 font-normal">{t("carpool.person")}</th>
              <th className="py-1 pr-3 font-normal">{t("carpool.drives")}</th>
              <th className="py-1 pr-3 font-normal">{t("carpool.km")}</th>
              <th className="py-1 pr-3 font-normal">{t("carpool.carried")}</th>
              <th className="py-1 font-normal">{t("carpool.rides")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {stats.rows.map((r, i) => (
              <tr key={r.person?.id ?? `hidden-${i}`}>
                <td className="py-1 pr-3">
                  {r.person ? personLabel(r.person) : t("carpool.hiddenPerson")}
                </td>
                <td className="py-1 pr-3 tabular-nums">{r.drives}</td>
                <td className="py-1 pr-3 tabular-nums">{r.distanceKm}</td>
                <td className="py-1 pr-3 tabular-nums">{r.passengers}</td>
                <td className="py-1 tabular-nums">{r.rides}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {calendar?.canManage ? (
        <ActionForm action="carpool-group-settings" className="space-y-2">
          <input type="hidden" name="clubId" value={group.clubId} />
          <input type="hidden" name="groupId" value={group.id} />
          <input type="hidden" name="back" value={back} />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="statsPublic"
              defaultChecked={stats.public}
              data-testid="stats-public"
            />
            {t("carpool.statsPublic")}
          </label>
          <button type="submit" className={buttonClass}>
            {t("carpool.save")}
          </button>
        </ActionForm>
      ) : (
        <p className="text-sm text-muted">
          {stats.public ? t("carpool.statsArePublic") : t("carpool.statsOwnOnly")}
        </p>
      )}
    </div>
  );
}
