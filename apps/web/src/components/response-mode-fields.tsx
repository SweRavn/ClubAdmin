// SPDX-License-Identifier: AGPL-3.0-only
// Whether an activity or series asks for answers, and the deadline (P1.5):
// for a single activity a date and time in the club's time zone (P2.7b;
// empty: until it starts), for a series hours before each session.
// Empty mode: the default of the activity's kind.
import { enumKey } from "@clubadmin/i18n";
import { type RequestLead, RESPONSE_MODES } from "@clubadmin/shared";
import { getTranslations } from "next-intl/server";

import { inputClass } from "./action-form.tsx";

export async function ResponseModeFields({
  mode,
  hours,
  deadline,
}: {
  mode?: string | null | undefined;
  /** A series: hours before each session. */
  hours?: number | null | undefined;
  /** A single activity: the deadline's local date and time (both empty: until the start). */
  deadline?: { date: string; time: string } | undefined;
}) {
  const t = await getTranslations();
  return (
    <>
      <label className="block space-y-1">
        <span className="text-sm">{t("responses.mode")}</span>
        <select
          name="responseMode"
          className={inputClass}
          defaultValue={mode ?? ""}
          data-testid="response-mode"
        >
          <option value="">{t("responses.modeDefault")}</option>
          {RESPONSE_MODES.map((m) => (
            <option key={m} value={m}>
              {t(enumKey("responseModes", m))}
            </option>
          ))}
        </select>
      </label>
      {deadline ? (
        <fieldset className="space-y-1">
          <legend className="text-sm">{t("responses.respondBy")}</legend>
          <div className="grid grid-cols-2 gap-2">
            <input
              name="respondByDate"
              type="date"
              aria-label={t("responses.respondByDate")}
              className={inputClass}
              defaultValue={deadline.date}
              data-testid="respond-by-date"
            />
            <input
              name="respondByTime"
              type="time"
              aria-label={t("responses.respondByTime")}
              className={inputClass}
              defaultValue={deadline.time}
              data-testid="respond-by-time"
            />
          </div>
          <span className="block text-xs text-muted">{t("responses.respondByDateHint")}</span>
        </fieldset>
      ) : (
        <label className="block space-y-1">
          <span className="text-sm">{t("responses.respondBy")}</span>
          <input
            name="respondByHours"
            type="number"
            min={0}
            max={336}
            step={1}
            className={inputClass}
            defaultValue={hours ?? ""}
            data-testid="respond-by-hours"
          />
          <span className="block text-xs text-muted">{t("responses.respondByHint")}</span>
        </label>
      )}
    </>
  );
}

/**
 * When the group is asked to answer before each session (P1.14): no request,
 * N days before at a local time, or N hours before the start.
 */
export async function RequestLeadFields({ lead }: { lead?: RequestLead | null | undefined }) {
  const t = await getTranslations();
  const kind = lead?.kind ?? "";
  return (
    <fieldset className="space-y-2 rounded-lg border border-border p-3" data-testid="request-lead">
      <legend className="px-1 text-sm font-medium">{t("series.request")}</legend>
      <p className="text-xs text-muted">{t("series.requestHint")}</p>
      <label className="flex items-center gap-2">
        <input type="radio" name="requestKind" value="none" defaultChecked={kind === ""} />
        {t("series.requestNone")}
      </label>
      <label className="flex items-center gap-2">
        <input
          type="radio"
          name="requestKind"
          value="days"
          defaultChecked={kind === "days"}
          data-testid="request-days"
        />
        {t("series.requestDays")}
      </label>
      <div className="grid grid-cols-2 gap-2 ps-6">
        <label className="block space-y-1">
          <span className="text-sm">{t("series.requestDaysField")}</span>
          <input
            type="number"
            name="requestDays"
            min={0}
            max={14}
            className={inputClass}
            defaultValue={lead?.kind === "days" ? String(lead.days) : "3"}
            data-testid="request-days-field"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm">{t("series.requestTimeField")}</span>
          <input
            type="time"
            name="requestTime"
            className={inputClass}
            defaultValue={lead?.kind === "days" ? lead.time : "18:00"}
            data-testid="request-time-field"
          />
        </label>
      </div>
      <label className="flex items-center gap-2">
        <input type="radio" name="requestKind" value="hours" defaultChecked={kind === "hours"} />
        {t("series.requestHours")}
      </label>
      <label className="block space-y-1 ps-6">
        <span className="text-sm">{t("series.requestHoursField")}</span>
        <input
          type="number"
          name="requestHours"
          min={1}
          max={72}
          className={inputClass}
          defaultValue={lead?.kind === "hours" ? String(lead.hours) : "48"}
        />
      </label>
    </fieldset>
  );
}
