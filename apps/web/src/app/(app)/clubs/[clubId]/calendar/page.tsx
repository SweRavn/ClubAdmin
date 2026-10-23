// SPDX-License-Identifier: AGPL-3.0-only
// The club calendar (P1.4): every activity of the club, two weeks at a time,
// by group or location (administrators and the board). Groups and places,
// never participants.
import { isUuid } from "@clubadmin/shared";
import { forbidden } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { inputClass, secondaryButtonClass } from "../../../../../components/action-form.tsx";
import { Agenda, agendaItemOf, weekOffset, weekRange } from "../../../../../components/agenda.tsx";
import {
  getClub,
  getClubCalendar,
  getClubGroups,
  getLocations,
  getMyClubs,
} from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};
const WEEKS = 2;

export async function generateMetadata() {
  return { title: (await getTranslations())("clubCalendar.title") };
}

export default async function ClubCalendarPage({ params, searchParams }: Props) {
  const [{ clubId }, query] = await Promise.all([params, searchParams]);
  const [t, club, mine] = await Promise.all([getTranslations(), getClub(clubId), getMyClubs()]);
  const permissions = mine.clubs.find((c) => c.club.id === club.id)?.permissions ?? [];
  if (!permissions.includes("club.activities.read")) forbidden();
  const week = weekOffset(query.week);
  const groupId = typeof query.groupId === "string" && isUuid(query.groupId) ? query.groupId : null;
  const locationId =
    typeof query.locationId === "string" && isUuid(query.locationId) ? query.locationId : null;
  const { from, to } = weekRange(week, WEEKS);
  const filter = `${groupId ? `&groupId=${groupId}` : ""}${locationId ? `&locationId=${locationId}` : ""}`;
  const [calendar, groups, locations] = await Promise.all([
    getClubCalendar(club.id, from, to, filter),
    getClubGroups(club.id),
    getLocations(club.id),
  ]);
  const link = (w: number) =>
    `/clubs/${club.id}/calendar?week=${w}${groupId ? `&groupId=${groupId}` : ""}${
      locationId ? `&locationId=${locationId}` : ""
    }`;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t("clubCalendar.title")}</h1>
      <form
        method="get"
        className="flex flex-wrap items-end gap-3"
        data-testid="club-calendar-filter"
      >
        <label className="block space-y-1">
          <span className="text-sm">{t("clubCalendar.group")}</span>
          <select name="groupId" defaultValue={groupId ?? ""} className={inputClass}>
            <option value="">{t("clubCalendar.allGroups")}</option>
            {groups
              .filter((g) => !g.archived)
              .map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-sm">{t("activities.location")}</span>
          <select name="locationId" defaultValue={locationId ?? ""} className={inputClass}>
            <option value="">{t("clubCalendar.allLocations")}</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className={secondaryButtonClass}>
          {t("clubCalendar.show")}
        </button>
      </form>
      <Agenda
        items={calendar.items.map(agendaItemOf)}
        emptyText={t("activities.noneInRange")}
        testId="club-calendar"
      />
      <nav className="flex justify-between text-sm" aria-label={t("schedule.weeks")}>
        <a href={link(week - WEEKS)} className="underline">
          {t("schedule.earlier")}
        </a>
        <a href={link(week + WEEKS)} className="underline">
          {t("schedule.later")}
        </a>
      </nav>
    </div>
  );
}
