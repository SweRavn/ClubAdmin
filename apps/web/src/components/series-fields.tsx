// SPDX-License-Identifier: AGPL-3.0-only
// The fields of the series forms (new, change from a date, split): title,
// how it repeats (P1.14: weekly slots, every n days/weeks/months, monthly by
// position or day), when it ends (a date or until further notice), skipped
// dates and public holidays, place, notes, answers and the answer request.
// Works without client JavaScript: every choice is a plain form field.
import { weekdayName } from "@clubadmin/i18n";
import type { Location, RequestLead, SeriesRule, SeriesSlot } from "@clubadmin/shared";
import { getLocale, getTranslations } from "next-intl/server";

import {
  POSITION_ROWS,
  recurrenceFrom,
  requestLeadFrom,
  SLOT_ROWS,
} from "../server/series-form.ts";
import { inputClass } from "./action-form.tsx";
import { RequestLeadFields, ResponseModeFields } from "./response-mode-fields.tsx";

export interface SeriesFieldValues {
  title?: string;
  rule?: SeriesRule;
  slots?: readonly SeriesSlot[];
  startsOn?: string;
  /** Null: until further notice. */
  endsOn?: string | null;
  requestLead?: RequestLead | null;
  skipDates?: readonly string[];
  skipPublicHolidays?: boolean;
  locationId?: string | null;
  locationText?: string | null;
  notes?: string | null;
  leaderNotes?: string | null;
  responseMode?: string | null;
  respondByHours?: number | null;
}

/** Weekday names (Monday first) in the viewer's language. */
function weekdayNames(locale: string): string[] {
  return Array.from({ length: 7 }, (_, i) => weekdayName(locale, i + 1));
}
const ORDINALS = ["1", "2", "3", "4", "last"] as const;

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
  const rule: SeriesRule = values.rule ?? { freq: "weekly", interval: 1 };
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
      <fieldset className="space-y-2 rounded-lg border border-border p-3">
        <legend className="px-1 text-sm font-medium">{t("series.repeats")}</legend>
        <p className="text-xs text-muted">{t("activities.timeZoneHint", { zone: timeZone })}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1">
            <span className="text-sm">{t("series.rule")}</span>
            <select
              name="freq"
              className={inputClass}
              defaultValue={rule.freq}
              data-testid="series-freq"
            >
              {(["weekly", "daily", "monthly"] as const).map((f) => (
                <option key={f} value={f}>
                  {t(`series.freq.${f}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-sm">{t("series.interval")}</span>
            <input
              type="number"
              name="interval"
              min={1}
              max={52}
              className={inputClass}
              defaultValue={String(rule.interval)}
              data-testid="series-interval"
            />
            <span className="block text-xs text-muted">{t("series.intervalHint")}</span>
          </label>
        </div>
        <p className="text-sm">{t("series.slotsHint")}</p>
        {Array.from({ length: SLOT_ROWS }, (_, n) => {
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
        <div className="space-y-2 border-t border-border pt-2">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-sm">{t("series.ruleTime")}</span>
              <input
                type="time"
                name="ruleTime"
                className={inputClass}
                defaultValue={rule.startTime ?? ""}
                data-testid="series-rule-time"
              />
            </label>
            <label className="flex items-end gap-2">
              <input
                type="number"
                name="ruleDuration"
                min={15}
                max={720}
                step={5}
                aria-label={t("series.duration")}
                className={inputClass}
                defaultValue={String(rule.durationMinutes ?? 90)}
              />
              <span className="text-sm text-muted">{t("series.minutes")}</span>
            </label>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm">{t("series.monthlyBy")}</legend>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="monthlyBy"
                value="position"
                defaultChecked={!rule.byMonthDay?.length}
              />
              {t("series.monthlyByPosition")}
            </label>
            {Array.from({ length: POSITION_ROWS }, (_, n) => {
              const position = rule.byDay?.[n];
              return (
                <div key={n} className="grid grid-cols-2 gap-2 ps-6">
                  <select
                    name={`ordinal.${n}`}
                    aria-label={t("series.ordinal")}
                    className={inputClass}
                    defaultValue={
                      position ? (position.ordinal === -1 ? "last" : String(position.ordinal)) : ""
                    }
                    data-testid={`series-ordinal-${n}`}
                  >
                    <option value="">{t("series.noSlot")}</option>
                    {ORDINALS.map((o) => (
                      <option key={o} value={o}>
                        {t(`series.ordinals.${o}`)}
                      </option>
                    ))}
                  </select>
                  <select
                    name={`posWeekday.${n}`}
                    aria-label={t("series.weekday")}
                    className={inputClass}
                    defaultValue={position ? String(position.weekday) : ""}
                    data-testid={`series-pos-weekday-${n}`}
                  >
                    <option value="">{t("series.noSlot")}</option>
                    {days.map((day, i) => (
                      <option key={day} value={String(i + 1)}>
                        {day}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="monthlyBy"
                value="day"
                defaultChecked={Boolean(rule.byMonthDay?.length)}
                data-testid="series-monthly-by-day"
              />
              {t("series.monthlyByDay")}
            </label>
            <label className="block space-y-1 ps-6">
              <span className="text-sm">{t("series.monthDays")}</span>
              <input
                name="monthDays"
                className={inputClass}
                defaultValue={(rule.byMonthDay ?? []).join(", ")}
                placeholder="15"
                data-testid="series-month-days"
              />
              <span className="block text-xs text-muted">{t("series.monthDaysHint")}</span>
            </label>
          </fieldset>
        </div>
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
        <fieldset className="space-y-1">
          <legend className="text-sm">{t("series.ends")}</legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="endMode"
              value="never"
              defaultChecked={values.endsOn === null}
              data-testid="series-ends-never"
            />
            {t("series.endsNever")}
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="endMode"
              value="date"
              defaultChecked={values.endsOn !== null}
              data-testid="series-ends-date"
            />
            {t("series.endsOnDate")}
          </label>
          <input
            type="date"
            name="endsOn"
            aria-label={t("series.endsOn")}
            className={inputClass}
            defaultValue={values.endsOn ?? ""}
            data-testid="series-endsOn"
          />
          <span className="block text-xs text-muted">{t("series.endsHint")}</span>
        </fieldset>
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
      <RequestLeadFields lead={values.requestLead} />
    </div>
  );
}

/** Series form values from a preview request's query (?weekday.0=…), for "Preview" round trips. */
export function seriesValuesFromQuery(
  query: Record<string, string | string[] | undefined>,
): SeriesFieldValues & { slots: SeriesSlot[]; valid: boolean } {
  const value = (key: string) => (typeof query[key] === "string" ? query[key] : "");
  const recurrence = recurrenceFrom(value);
  const requestLead = requestLeadFrom(value);
  return {
    title: value("title"),
    ...(recurrence ? { rule: recurrence.rule } : {}),
    slots: recurrence?.slots ?? [],
    startsOn: value("startsOn"),
    endsOn: recurrence?.endsOn === undefined ? "" : recurrence.endsOn,
    requestLead: requestLead ?? null,
    valid: recurrence !== null && recurrence.endsOn !== undefined && requestLead !== undefined,
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
