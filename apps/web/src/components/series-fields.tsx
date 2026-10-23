// SPDX-License-Identifier: AGPL-3.0-only
// The fields of the series forms (new, change from a date, split): title,
// up to three weekly slots (weekday, local start time, length), dates,
// skipped dates and public holidays, place and notes.
import type { Location, SeriesSlot } from "@clubadmin/shared";
import { getLocale, getTranslations } from "next-intl/server";

import { inputClass } from "./action-form.tsx";
import { ResponseModeFields } from "./response-mode-fields.tsx";

export interface SeriesFieldValues {
  title?: string;
  slots?: readonly SeriesSlot[];
  startsOn?: string;
  endsOn?: string;
  skipDates?: readonly string[];
  skipPublicHolidays?: boolean;
  locationId?: string | null;
  locationText?: string | null;
  notes?: string | null;
  leaderNotes?: string | null;
  responseMode?: string | null;
  respondByHours?: number | null;
}

const SLOTS = 3;

/** Weekday names (Monday first) in the viewer's language. */
function weekdayNames(locale: string): string[] {
  const monday = Date.UTC(2024, 0, 1);
  return Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(
      new Date(monday + i * 86_400_000),
    ),
  );
}

export async function SeriesFields({
  timeZone,
  locations,
  values = {},
  withStart = true,
}: {
  timeZone: string;
  locations: readonly Location[];
  values?: SeriesFieldValues;
  /** The first date (new series only; a change keeps it). */
  withStart?: boolean;
}) {
  const t = await getTranslations();
  const days = weekdayNames(await getLocale());
  return (
    <div className="space-y-4">
      <input type="hidden" name="timeZone" value={timeZone} />
      <label className="block space-y-1">
        <span className="text-sm">{t("activities.titleField")}</span>
        <input
          name="title"
          required={withStart}
          maxLength={120}
          className={inputClass}
          defaultValue={values.title ?? ""}
          data-testid="series-title"
        />
      </label>
      <fieldset className="space-y-2">
        <legend className="text-sm">{t("series.slots")}</legend>
        <p className="text-xs text-muted">{t("activities.timeZoneHint", { zone: timeZone })}</p>
        {Array.from({ length: SLOTS }, (_, n) => {
          const slot = values.slots?.[n];
          return (
            <div key={n} className="grid grid-cols-3 gap-2" data-testid={`series-slot-${n}`}>
              <select
                name={`weekday.${n}`}
                aria-label={t("series.weekday")}
                className={inputClass}
                defaultValue={slot ? String(slot.weekday) : ""}
                data-testid={`series-weekday-${n}`}
              >
                <option value="">{t("series.noSlot")}</option>
                {days.map((day, i) => (
                  <option key={day} value={String(i + 1)}>
                    {day}
                  </option>
                ))}
              </select>
              <input
                type="time"
                name={`startTime.${n}`}
                aria-label={t("activities.startTime")}
                className={inputClass}
                defaultValue={slot?.startTime ?? ""}
                data-testid={`series-start-${n}`}
              />
              <label className="flex items-center gap-2">
                <input
                  type="number"
                  name={`duration.${n}`}
                  min={15}
                  max={720}
                  step={5}
                  aria-label={t("series.duration")}
                  className={inputClass}
                  defaultValue={String(slot?.durationMinutes ?? 90)}
                />
                <span className="text-sm text-muted">{t("series.minutes")}</span>
              </label>
            </div>
          );
        })}
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        {withStart ? (
          <label className="block space-y-1">
            <span className="text-sm">{t("series.startsOn")}</span>
            <input
              type="date"
              name="startsOn"
              required
              className={inputClass}
              defaultValue={values.startsOn ?? ""}
              data-testid="series-startsOn"
            />
          </label>
        ) : null}
        <label className="block space-y-1">
          <span className="text-sm">{t("series.endsOn")}</span>
          <input
            type="date"
            name="endsOn"
            required={withStart}
            className={inputClass}
            defaultValue={values.endsOn ?? ""}
            data-testid="series-endsOn"
          />
        </label>
      </div>
      <label className="block space-y-1">
        <span className="text-sm">{t("series.skipDates")}</span>
        <input
          name="skipDates"
          className={inputClass}
          defaultValue={(values.skipDates ?? []).join(", ")}
          placeholder="2026-02-17, 2026-02-19"
          data-testid="series-skipDates"
        />
        <span className="text-xs text-muted">{t("series.skipDatesHint")}</span>
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          name="skipPublicHolidays"
          defaultChecked={values.skipPublicHolidays ?? true}
          data-testid="series-skipHolidays"
        />
        {t("series.skipPublicHolidays")}
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className="text-sm">{t("activities.location")}</span>
          <select
            name="locationId"
            className={inputClass}
            defaultValue={values.locationId ?? ""}
            data-testid="series-locationId"
          >
            <option value="">{t("activities.otherPlace")}</option>
            {locations
              .filter((l) => !l.archived || l.id === values.locationId)
              .map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-sm">{t("activities.locationText")}</span>
          <input
            name="locationText"
            maxLength={200}
            className={inputClass}
            defaultValue={values.locationText ?? ""}
          />
        </label>
      </div>
      <label className="block space-y-1">
        <span className="text-sm">{t("activities.notes")}</span>
        <textarea
          name="notes"
          rows={2}
          maxLength={2000}
          className={inputClass}
          defaultValue={values.notes ?? ""}
        />
      </label>
      <label className="block space-y-1">
        <span className="text-sm">{t("activities.leaderNotes")}</span>
        <textarea
          name="leaderNotes"
          rows={2}
          maxLength={2000}
          className={inputClass}
          defaultValue={values.leaderNotes ?? ""}
        />
        <span className="text-xs text-muted">{t("activities.leaderNotesHint")}</span>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <ResponseModeFields mode={values.responseMode} hours={values.respondByHours} />
      </div>
    </div>
  );
}

/** Series form values from a preview request's query (?weekday.0=…), for "Preview" round trips. */
export function seriesValuesFromQuery(
  query: Record<string, string | string[] | undefined>,
): SeriesFieldValues & { slots: SeriesSlot[] } {
  const value = (key: string) => (typeof query[key] === "string" ? query[key] : "");
  const slots: SeriesSlot[] = [];
  for (let n = 0; n < SLOTS; n++) {
    const weekday = Number(value(`weekday.${n}`));
    const startTime = value(`startTime.${n}`);
    const durationMinutes = Number(value(`duration.${n}`)) || 90;
    if (weekday >= 1 && weekday <= 7 && /^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)) {
      slots.push({ weekday, startTime, durationMinutes });
    }
  }
  return {
    title: value("title"),
    slots,
    startsOn: value("startsOn"),
    endsOn: value("endsOn"),
    skipDates: value("skipDates")
      .split(/[\s,;]+/)
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
    skipPublicHolidays: query.preview === undefined ? true : value("skipPublicHolidays") === "on",
    locationId: value("locationId") || null,
    locationText: value("locationText") || null,
    notes: value("notes") || null,
    leaderNotes: value("leaderNotes") || null,
  };
}
