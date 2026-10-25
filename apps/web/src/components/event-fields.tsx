// SPDX-License-Identifier: AGPL-3.0-only
// The fields of the event forms (new and edit, P1.6): details, sign-up
// period, cancellation deadline, capacity and waiting list, the price text
// and the questions as numbered rows (empty rows are left out). Works
// without client JavaScript: "Add a question" saves and returns with one
// more empty row.
import { enumKey } from "@clubadmin/i18n";
import {
  type EventQuestion,
  localDate,
  localTime,
  type Location,
  QUESTION_TYPES,
  WAITLIST_MODES,
} from "@clubadmin/shared";
import { getTranslations } from "next-intl/server";

import { inputClass } from "./action-form.tsx";

export interface EventFieldValues {
  title?: string;
  description?: string | null;
  startsAt?: string;
  endsAt?: string;
  locationId?: string | null;
  locationText?: string | null;
  priceText?: string | null;
  registrationOpensAt?: string | null;
  registrationClosesAt?: string;
  cancellationClosesAt?: string | null;
  capacity?: number | null;
  waitlistMode?: string;
  offerReplyHours?: number;
  questions?: readonly EventQuestion[];
}

/** Local date and time fields of an instant in the club's time zone. */
function local(value: string | null | undefined, timeZone: string) {
  if (!value) return { date: "", time: "" };
  return { date: localDate(new Date(value), timeZone), time: localTime(new Date(value), timeZone) };
}

export async function EventFields({
  timeZone,
  locations,
  values = {},
  emptyRows = 1,
}: {
  timeZone: string;
  locations: readonly Location[];
  values?: EventFieldValues;
  emptyRows?: number;
}) {
  const t = await getTranslations();
  const field = (
    name: string,
    label: string,
    defaultValue: string | number | null | undefined,
    props: Record<string, unknown> = {},
  ) => (
    <label className="block space-y-1">
      <span className="text-sm">{label}</span>
      <input
        name={name}
        className={inputClass}
        defaultValue={defaultValue ?? ""}
        data-testid={`event-${name}`}
        {...props}
      />
    </label>
  );
  const moment = (
    prefix: string,
    label: string,
    value: string | null | undefined,
    required: boolean,
  ) => {
    const v = local(value, timeZone);
    return (
      <fieldset className="grid grid-cols-2 gap-3">
        <legend className="mb-1 text-sm">{label}</legend>
        {field(`${prefix}Date`, t("events.date"), v.date, { type: "date", required })}
        {field(`${prefix}Time`, t("events.time"), v.time, { type: "time", required })}
      </fieldset>
    );
  };
  const questions = values.questions ?? [];
  const rows = [...questions, ...Array.from({ length: emptyRows }, () => null)];

  return (
    <div className="space-y-6">
      <input type="hidden" name="timeZone" value={timeZone} />
      <div className="grid gap-3 sm:grid-cols-2">
        {field("title", t("events.titleField"), values.title, { required: true, maxLength: 200 })}
        {field("priceText", t("events.priceText"), values.priceText, { maxLength: 100 })}
        <label className="block space-y-1 sm:col-span-2">
          <span className="text-sm">{t("events.description")}</span>
          <textarea
            name="description"
            rows={4}
            maxLength={4000}
            className={inputClass}
            defaultValue={values.description ?? ""}
          />
        </label>
        {moment("start", t("events.starts"), values.startsAt, true)}
        {moment("end", t("events.ends"), values.endsAt, true)}
        <label className="block space-y-1">
          <span className="text-sm">{t("activities.location")}</span>
          <select name="locationId" className={inputClass} defaultValue={values.locationId ?? ""}>
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
        {field("locationText", t("activities.locationText"), values.locationText, {
          maxLength: 200,
        })}
        <p className="text-xs text-muted sm:col-span-2">
          {t("activities.timeZoneHint", { zone: timeZone })}
        </p>
      </div>

      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-1 text-lg font-semibold">{t("events.signUp")}</legend>
        {moment("opens", t("events.opens"), values.registrationOpensAt, false)}
        {moment("closes", t("events.closesField"), values.registrationClosesAt, true)}
        {moment("cancel", t("events.cancelDeadline"), values.cancellationClosesAt, false)}
        {field("capacity", t("events.capacity"), values.capacity, { type: "number", min: 1 })}
        <label className="block space-y-1">
          <span className="text-sm">{t("events.waitlistMode")}</span>
          <select
            name="waitlistMode"
            className={inputClass}
            defaultValue={values.waitlistMode ?? ""}
            data-testid="event-waitlistMode"
          >
            {values.waitlistMode ? null : <option value="">{t("events.waitlistDefault")}</option>}
            {WAITLIST_MODES.map((m) => (
              <option key={m} value={m}>
                {t(enumKey("events.waitlistModes", m))}
              </option>
            ))}
          </select>
        </label>
        {field("offerReplyHours", t("events.offerReplyHours"), values.offerReplyHours ?? 24, {
          type: "number",
          min: 1,
          max: 168,
        })}
      </fieldset>

      <fieldset className="space-y-3" data-testid="event-questions">
        <legend className="mb-1 text-lg font-semibold">{t("events.questions")}</legend>
        <p className="text-sm text-muted">{t("events.questionsHint")}</p>
        {rows.map((q, i) => (
          <div
            key={q?.id ?? `new-${i}`}
            className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-6"
          >
            <input type="hidden" name={`q.${i}.id`} value={q?.id ?? ""} />
            <label className="block space-y-1 sm:col-span-3">
              <span className="text-sm">{t("events.questionLabel")}</span>
              <input
                name={`q.${i}.label`}
                className={inputClass}
                defaultValue={q?.label ?? ""}
                maxLength={200}
                data-testid="question-label"
              />
            </label>
            <label className="block space-y-1 sm:col-span-2">
              <span className="text-sm">{t("events.questionType")}</span>
              <select
                name={`q.${i}.type`}
                className={inputClass}
                defaultValue={q?.type ?? "short_text"}
                data-testid="question-type"
              >
                {QUESTION_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(enumKey("events.questionTypes", type))}
                  </option>
                ))}
              </select>
            </label>
            {field(`q.${i}.order`, t("events.questionOrder"), i + 1, { type: "number", min: 1 })}
            <label className="block space-y-1 sm:col-span-4">
              <span className="text-sm">{t("events.questionOptions")}</span>
              <textarea
                name={`q.${i}.options`}
                rows={2}
                className={inputClass}
                defaultValue={q?.options?.join("\n") ?? ""}
              />
            </label>
            <div className="space-y-1 text-sm sm:col-span-2">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  name={`q.${i}.required`}
                  defaultChecked={q?.required ?? false}
                />
                {t("events.questionRequired")}
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  name={`q.${i}.sensitive`}
                  defaultChecked={q?.sensitive ?? false}
                  data-testid="question-sensitive"
                />
                {t("events.questionSensitive")}
              </label>
              {q ? (
                <label className="flex items-center gap-2">
                  <input type="checkbox" name={`q.${i}.remove`} />
                  {t("events.questionRemove")}
                </label>
              ) : null}
            </div>
          </div>
        ))}
      </fieldset>
    </div>
  );
}
