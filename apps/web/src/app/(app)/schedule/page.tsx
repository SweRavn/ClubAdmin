// SPDX-License-Identifier: AGPL-3.0-only
// My schedule (P1.4): the activities of my groups and my wards' groups
// (those whose schedule I may see), across clubs, four weeks at a time.
// Chips narrow it to one person; when viewing as a ward, only theirs.
import { isUuid } from "@clubadmin/shared";
import { personLabel } from "@clubadmin/ui";
import { getTranslations } from "next-intl/server";

import { Agenda, weekOffset, weekRange } from "../../../components/agenda.tsx";
import { FormError, Notice } from "../../../components/form-error.tsx";
import { getSchedule } from "../../../server/data.ts";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
const WEEKS = 4;

export async function generateMetadata() {
  return { title: (await getTranslations())("schedule.title") };
}

export default async function SchedulePage({ searchParams }: Props) {
  const params = await searchParams;
  const offset = weekOffset(params.week);
  const person = typeof params.person === "string" && isUuid(params.person) ? params.person : null;
  const { from, to } = weekRange(offset, WEEKS);
  const [t, schedule] = await Promise.all([
    getTranslations(),
    getSchedule(from, to, person ? `&personId=${person}` : ""),
  ]);
  const link = (changes: { week?: number; person?: string | null }) => {
    const query = new URLSearchParams();
    const week = changes.week ?? offset;
    const who = changes.person === undefined ? person : changes.person;
    if (week !== 0) query.set("week", String(week));
    if (who) query.set("person", who);
    const qs = query.toString();
    return `/schedule${qs ? `?${qs}` : ""}`;
  };
  const chip = (active: boolean) =>
    `rounded-full border px-3 py-1 text-sm ${
      active ? "border-accent bg-accent-soft" : "border-border hover:bg-surface"
    }`;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t("schedule.title")}</h1>
      {params.answered ? <Notice>{t("responses.saved")}</Notice> : null}
      <FormError code={typeof params.error === "string" ? params.error : undefined} />
      {schedule.people.length > 1 ? (
        <nav
          aria-label={t("schedule.people")}
          className="flex flex-wrap gap-2"
          data-testid="schedule-people"
        >
          <a
            href={link({ person: null })}
            className={chip(person === null)}
            aria-current={person === null ? "page" : undefined}
          >
            {t("schedule.everyone")}
          </a>
          {schedule.people.map((p) => (
            <a
              key={p.id}
              href={link({ person: p.id })}
              className={chip(person === p.id)}
              aria-current={person === p.id ? "page" : undefined}
            >
              {personLabel(p)}
            </a>
          ))}
        </nav>
      ) : null}
      <Agenda
        showPeople={schedule.people.length > 1 && person === null}
        emptyText={t("schedule.empty")}
        testId="schedule"
        items={schedule.items.map((e) => ({
          id: e.activityId,
          href: `/activities/${e.activityId}`,
          title: e.title,
          kind: e.kind,
          status: e.status,
          cancelledReason: e.cancelledReason,
          startsAt: e.startsAt,
          endsAt: e.endsAt,
          allDay: e.allDay,
          timeZone: e.club.timeZone,
          place: e.place,
          groups: e.groups,
          people: e.people,
          ...(e.responseMode ? { responseMode: e.responseMode } : {}),
          respondBy: e.respondBy ?? null,
          responses: (e.responses ?? []).map((r) => {
            const who = e.people.find((p) => p.id === r.personId);
            return {
              personId: r.personId,
              label: e.people.length > 1 && who ? personLabel(who) : null,
              status: r.status,
              canRespond: r.canRespond,
            };
          }),
        }))}
      />
      {schedule.nextCursor ? <p className="text-sm text-muted">{t("schedule.more")}</p> : null}
      <nav className="flex justify-between text-sm" aria-label={t("schedule.weeks")}>
        <a
          href={link({ week: offset - WEEKS })}
          className="underline"
          data-testid="schedule-earlier"
        >
          {t("schedule.earlier")}
        </a>
        {offset !== 0 ? (
          <a href={link({ week: 0 })} className="underline">
            {t("schedule.now")}
          </a>
        ) : null}
        <a href={link({ week: offset + WEEKS })} className="underline" data-testid="schedule-later">
          {t("schedule.later")}
        </a>
      </nav>
    </div>
  );
}
