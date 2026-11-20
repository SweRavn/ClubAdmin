// SPDX-License-Identifier: AGPL-3.0-only
// My schedule (P1.4), on Home since P2.7d: the activities of my groups and my wards' groups
// (those whose schedule I may see), across clubs: this week, four weeks at a
// time on "Visa fler veckor" (`?weeks=4`). One week keeps Home's first paint
// light (ADR 0040: the LCP budget); the rest is a tap away.
// Chips narrow it to one person; when viewing as a ward, only theirs.
import { isUuid } from "@clubadmin/shared";
import { personLabel } from "@clubadmin/ui";
import { getTranslations } from "next-intl/server";

import { getCarpoolSummaries, getMyEvents, getSchedule } from "../server/data.ts";
import { Agenda, weekOffset, weekRange } from "./agenda.tsx";
import { ClubTime } from "./club-time.tsx";
import { Notice } from "./form-error.tsx";

/** Weeks shown after "Visa fler veckor"; Home starts with one. */
const MORE_WEEKS = 4;

/**
 * My schedule (P1.4, P1.5, P2.7c): the person filter, events open for
 * sign-up, the activities with each person's answer, the "Kommer" menu and
 * the seats, and the weeks. Shown on Home since P2.7d (the "Mitt schema"
 * page redirects there).
 */
export async function MySchedule({
  params,
  basePath = "/",
}: {
  params: Record<string, string | string[] | undefined>;
  basePath?: string;
}) {
  const offset = weekOffset(params.week);
  const weeks = params.weeks === String(MORE_WEEKS) ? MORE_WEEKS : 1;
  const person = typeof params.person === "string" && isUuid(params.person) ? params.person : null;
  const { from, to } = weekRange(offset, weeks);
  const [t, schedule, events] = await Promise.all([
    getTranslations(),
    getSchedule(from, to, person ? `&personId=${person}` : ""),
    getMyEvents(),
  ]);
  // Events open for sign-up for me or my wards (P1.6): "Sign up by …".
  // The car pools of the page's activities (P2.7c): one request per club.
  const carpools = await getCarpoolSummaries(
    schedule.items
      .filter((e) => e.status === "scheduled" && Date.parse(e.startsAt) > Date.now())
      .map((e) => ({ activityId: e.activityId, clubId: e.club.id })),
  );
  const signUp = events.items.filter(
    (i) => i.event.open && i.people.some((p) => p.canRegister && p.status === null),
  );
  const link = (changes: { week?: number; person?: string | null; weeks?: number }) => {
    const query = new URLSearchParams();
    const week = changes.week ?? offset;
    const who = changes.person === undefined ? person : changes.person;
    const shown = changes.weeks ?? weeks;
    if (week !== 0) query.set("week", String(week));
    if (who) query.set("person", who);
    if (shown !== 1) query.set("weeks", String(shown));
    const qs = query.toString();
    return `${basePath}${qs ? `?${qs}` : ""}`;
  };
  const chip = (active: boolean) =>
    `rounded-full border px-3 py-1 text-sm ${
      active ? "border-accent bg-accent-soft" : "border-border hover:bg-surface"
    }`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">{t("schedule.title")}</h2>
        <a href="/me/calendar" className="text-sm underline" data-testid="schedule-subscribe">
          {t("calendar.ui.subscribe")}
        </a>
      </div>
      {params.answered ? <Notice>{t("responses.saved")}</Notice> : null}
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
      {signUp.length > 0 ? (
        <section
          aria-labelledby="schedule-sign-up"
          className="space-y-2"
          data-testid="schedule-events"
        >
          <h2 id="schedule-sign-up" className="text-lg font-semibold">
            {t("events.openForSignUp")}
          </h2>
          <ul className="space-y-1">
            {signUp.map(({ event }) => (
              <li key={event.id}>
                <a href={`/events/${event.id}`} className="underline">
                  {event.title}
                </a>{" "}
                <span className="text-sm text-muted">
                  {t("events.signUpBy")}{" "}
                  <ClubTime
                    value={event.registrationClosesAt}
                    timeZone={event.timeZone}
                    dateStyle="medium"
                    timeStyle="short"
                  />
                </span>
              </li>
            ))}
          </ul>
        </section>
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
          kindLabel: e.kindLabel ?? null,
          status: e.status,
          cancelledReason: e.cancelledReason,
          startsAt: e.startsAt,
          endsAt: e.endsAt,
          allDay: e.allDay,
          timeZone: e.club.timeZone,
          place: e.place,
          groups: e.groups,
          people: e.people,
          carpool: carpools.get(e.activityId),
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
      {weeks === 1 ? (
        <p>
          <a
            href={link({ weeks: MORE_WEEKS })}
            className="text-sm underline"
            data-testid="schedule-more-weeks"
          >
            {t("schedule.moreWeeks")}
          </a>
        </p>
      ) : null}
      <nav className="flex justify-between text-sm" aria-label={t("schedule.weeks")}>
        <a
          href={link({ week: offset - weeks })}
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
        <a href={link({ week: offset + weeks })} className="underline" data-testid="schedule-later">
          {t("schedule.later")}
        </a>
      </nav>
    </div>
  );
}
