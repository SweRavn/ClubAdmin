// SPDX-License-Identifier: AGPL-3.0-only
// A programme (P2.9, ADR 0054 decision 12): one day at a time as a column
// per place (halls and pitches; items without a place in their own column),
// each activity with its time, groups and shifts (filled of needed); a list
// per place on narrow screens. Organisers see everything with conflicts
// marked, and copy it, save it as a template or remove it while untouched.
import { enumKey } from "@clubadmin/i18n";
import type { ProgrammeTimeline } from "@clubadmin/shared";
import { getLocale, getTranslations } from "next-intl/server";

import {
  ActionForm,
  buttonClass,
  inputClass,
  secondaryButtonClass,
} from "../../../../../../components/action-form.tsx";
import { FormError, Notice } from "../../../../../../components/form-error.tsx";
import { getClub, getProgramme, getProgrammeTimeline } from "../../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string; programmeId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props) {
  const { clubId, programmeId } = await params;
  return { title: (await getProgramme(clubId, programmeId)).title };
}

export default async function ProgrammePage({ params, searchParams }: Props) {
  const [{ clubId, programmeId }, query, t, locale] = await Promise.all([
    params,
    searchParams,
    getTranslations(),
    getLocale(),
  ]);
  const [club, programme] = await Promise.all([getClub(clubId), getProgramme(clubId, programmeId)]);
  const asked = typeof query.day === "string" ? query.day : null;
  const day = asked && programme.days.includes(asked) ? asked : programme.days[0]!;
  const timeline = await getProgrammeTimeline(club.id, programme.id, day);
  const tz = programme.timeZone;
  const time = (iso: string) =>
    new Intl.DateTimeFormat(locale, { timeStyle: "short", timeZone: tz }).format(new Date(iso));
  const dayName = (d: string) =>
    new Intl.DateTimeFormat(locale, {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    }).format(new Date(`${d}T12:00:00Z`));
  const here = `/clubs/${club.id}/programmes/${programme.id}?day=${day}`;
  const columns = programme.places.filter(
    (p) =>
      timeline.activities.some((a) => (a.locationId ?? null) === p.locationId) ||
      timeline.shifts.some((s) => !s.activityId && (s.locationId ?? null) === p.locationId),
  );

  return (
    <div className="space-y-6" data-testid="programme-page">
      <div className="space-y-1">
        <p className="text-sm text-muted">
          <a href={`/clubs/${club.id}`} className="underline">
            {club.name}
          </a>
          {programme.groups.map((g) => (
            <span key={g.id}>
              {" · "}
              <a href={`/groups/${g.id}/programmes`} className="underline">
                {g.name}
              </a>
            </span>
          ))}
        </p>
        <h1 className="text-2xl font-semibold" data-testid="programme-title">
          {programme.title}
        </h1>
        <p className="text-sm text-muted">
          {programme.edition ? `${t("programmes.edition")} ${programme.edition} · ` : ""}
          {programme.firstDay === programme.lastDay
            ? dayName(programme.firstDay)
            : `${dayName(programme.firstDay)} – ${dayName(programme.lastDay)}`}
          {programme.eventId ? (
            <>
              {" · "}
              <a href={`/events/${programme.eventId}`} className="underline">
                {t("programmes.event")}
              </a>
            </>
          ) : null}
        </p>
      </div>
      <FormError code={query.error} />
      {typeof query.saved === "string" ? (
        <Notice>{t(enumKey("programmes.saved", query.saved))}</Notice>
      ) : null}

      {programme.days.length > 1 ? (
        <nav className="flex flex-wrap gap-2" aria-label={t("programmes.days")}>
          {programme.days.map((d) => (
            <a
              key={d}
              href={`/clubs/${club.id}/programmes/${programme.id}?day=${d}`}
              aria-current={d === day ? "page" : undefined}
              className={d === day ? buttonClass : secondaryButtonClass}
              data-testid={`programme-day-${d}`}
            >
              {dayName(d)}
            </a>
          ))}
        </nav>
      ) : null}

      {columns.length === 0 ? (
        <p className="text-muted">{t("programmes.nothingThisDay")}</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" data-testid="programme-timeline">
          {columns.map((place) => (
            <section
              key={place.locationId ?? "none"}
              className="space-y-2 rounded-md border border-border p-3"
              data-testid={`programme-place-${place.locationId ?? "none"}`}
            >
              <h2 className="font-semibold">{place.name ?? t("programmes.noPlace")}</h2>
              {items(timeline, place.locationId).map((item) =>
                item.kind === "activity" ? (
                  <div
                    key={item.activity.id}
                    className={`rounded-md bg-surface p-2 ${item.activity.conflict ? "border-l-4 border-amber-500" : ""}`}
                    data-testid={`programme-activity-${item.activity.id}`}
                  >
                    <p className="text-sm text-muted">
                      {time(item.activity.startsAt)}–{time(item.activity.endsAt)}
                    </p>
                    <a href={`/activities/${item.activity.id}`} className="font-medium underline">
                      {item.activity.title}
                    </a>
                    {item.activity.status === "cancelled" ? (
                      <span className="ml-2 text-sm text-danger">{t("activities.cancelled")}</span>
                    ) : null}
                    <p className="text-sm text-muted">
                      {item.activity.groups.map((g) => g.name).join(", ")}
                      {item.activity.locationText ? ` · ${item.activity.locationText}` : ""}
                    </p>
                    {item.activity.conflict ? (
                      <p
                        className="text-sm text-amber-700 dark:text-amber-400"
                        data-testid="programme-conflict"
                      >
                        {t("programmes.conflict")}
                      </p>
                    ) : null}
                    <ShiftList shifts={item.shifts} time={time} />
                  </div>
                ) : (
                  <ShiftList key={item.shift.id} shifts={[item.shift]} time={time} />
                ),
              )}
            </section>
          ))}
        </div>
      )}

      {programme.canManage ? (
        <section className="max-w-lg space-y-4 border-t border-border pt-4">
          <a
            href={`/clubs/${club.id}/programmes/${programme.id}/copy`}
            className={secondaryButtonClass}
            data-testid="programme-copy"
          >
            {t("programmes.copy")}
          </a>
          <ActionForm
            action="programme-template-create"
            back={here}
            className="space-y-2"
            testId="programme-save-template"
          >
            <input type="hidden" name="clubId" value={club.id} />
            <input type="hidden" name="sourceKind" value="programme" />
            <input type="hidden" name="programmeId" value={programme.id} />
            <input
              type="hidden"
              name="scope"
              value={programme.groups.length === 1 ? programme.groups[0]!.id : "club"}
            />
            <label className="block space-y-1">
              <span className="font-medium">{t("programmes.templateName")}</span>
              <input
                name="name"
                required
                maxLength={120}
                defaultValue={programme.title}
                className={inputClass}
                data-testid="programme-template-name"
              />
            </label>
            <button type="submit" className={secondaryButtonClass}>
              {t("programmes.saveAsTemplate")}
            </button>
          </ActionForm>
          {programme.untouched ? (
            <ActionForm
              action="programme-delete"
              back={`/clubs/${club.id}/programmes`}
              className="space-y-1"
            >
              <input type="hidden" name="clubId" value={club.id} />
              <input type="hidden" name="programmeId" value={programme.id} />
              <p className="text-sm text-muted">{t("programmes.deleteHint")}</p>
              <button type="submit" className={secondaryButtonClass} data-testid="programme-delete">
                {t("programmes.delete")}
              </button>
            </ActionForm>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

type Activity = ProgrammeTimeline["activities"][number];
type Shift = ProgrammeTimeline["shifts"][number];

/** A column's activities with their shifts, and shifts on their own, by start. */
function items(
  timeline: ProgrammeTimeline,
  locationId: string | null,
): (
  | { kind: "activity"; activity: Activity; shifts: Shift[]; at: string }
  | { kind: "shift"; shift: Shift; at: string }
)[] {
  const activities = timeline.activities
    .filter((a) => (a.locationId ?? null) === locationId)
    .map((activity) => ({
      kind: "activity" as const,
      activity,
      shifts: timeline.shifts.filter((s) => s.activityId === activity.id),
      at: activity.startsAt,
    }));
  const shown = new Set(timeline.activities.map((a) => a.id));
  const loose = timeline.shifts
    .filter(
      (s) => (!s.activityId || !shown.has(s.activityId)) && (s.locationId ?? null) === locationId,
    )
    .map((shift) => ({ kind: "shift" as const, shift, at: shift.startsAt }));
  return [...activities, ...loose].sort((a, b) => a.at.localeCompare(b.at));
}

async function ShiftList({ shifts, time }: { shifts: Shift[]; time: (iso: string) => string }) {
  const t = await getTranslations();
  if (shifts.length === 0) return null;
  return (
    <ul className="mt-1 space-y-1 text-sm">
      {shifts.map((s) => (
        <li key={s.id} className="flex flex-wrap gap-2" data-testid={`programme-shift-${s.id}`}>
          <span>
            {time(s.startsAt)}–{time(s.endsAt)} {s.title}
          </span>
          <span
            className={s.filled < s.needed ? "text-amber-700 dark:text-amber-400" : "text-muted"}
          >
            {t("programmes.filled", { filled: s.filled, needed: s.needed })}
          </span>
          {s.mine ? <span className="font-medium">{t("programmes.mine")}</span> : null}
        </li>
      ))}
    </ul>
  );
}
