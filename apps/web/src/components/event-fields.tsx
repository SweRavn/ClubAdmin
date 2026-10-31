// SPDX-License-Identifier: AGPL-3.0-only
// The fields of the event forms (new and edit, P1.6): details, sign-up
// period, cancellation deadline, capacity and waiting list, the price text,
// the questions and (new group events) the sessions as numbered rows; empty
// rows are left out. Only the title and the start date are required
// (P1.6b): the rest shows its default as a hint. Rows are added in the
// browser; without JavaScript "Add" brings the form back with one more row
// and everything typed (form drafts). A failed save shows the values typed.
import { enumKey } from "@clubadmin/i18n";
import {
  ACTIVITY_KINDS,
  EVENT_ACTIVITIES_MAX,
  EVENT_QUESTIONS_MAX,
  type EventQuestion,
  localDate,
  localTime,
  type Location,
  QUESTION_TYPES,
  WAITLIST_MODES,
} from "@clubadmin/shared";
import { getTranslations } from "next-intl/server";

import type { FormDraft } from "../server/form-drafts.ts";
import { inputClass, secondaryButtonClass } from "./action-form.tsx";
import { EventPeriodCheck } from "./event-period-check.tsx";
import { RowList } from "./row-list.tsx";

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

/** A field's value: from the draft when there is one, else from the saved values. */
const fromDraft = (
  draft: FormDraft | null,
  name: string,
  saved: string | number | null | undefined,
) => (draft ? (draft.get(name)?.[0] ?? "") : (saved ?? ""));
const checked = (draft: FormDraft | null, name: string, saved: boolean) =>
  draft ? draft.get(name)?.[0] === "on" : saved;

/** Rows shown at first: the filled ones and one empty, or what "Add" asked for. */
function initialRows(filled: number, requested: unknown, max: number): number {
  const asked = Number(requested);
  return Math.min(Math.max(filled + 1, Number.isFinite(asked) ? asked : 0, 1), max);
}

const filledRows = (draft: FormDraft | null, prefix: string, field: string, max: number) => {
  if (!draft) return 0;
  let last = 0;
  for (let i = 0; i < max; i++) if (draft.get(`${prefix}.${i}.${field}`)?.[0]) last = i + 1;
  return last;
};

export async function EventFields({
  timeZone,
  locations,
  values = {},
  draft = null,
  questionRows,
  error,
}: {
  timeZone: string;
  locations: readonly Location[];
  values?: EventFieldValues;
  /** The form's values after a failed save or "Add" without JavaScript. */
  draft?: FormDraft | null;
  /** ?qrows: question rows asked for without JavaScript. */
  questionRows?: unknown;
  /** ?error, shown next to the end when it is about the period. */
  error?: unknown;
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
        defaultValue={fromDraft(draft, name, defaultValue)}
        data-testid={`event-${name}`}
        {...props}
      />
    </label>
  );
  const moment = (
    prefix: string,
    label: string,
    value: string | null | undefined,
    options: { required?: boolean; hint?: string } = {},
  ) => {
    const v = local(value, timeZone);
    return (
      <fieldset className="grid grid-cols-2 gap-3">
        <legend className="mb-1 text-sm">{label}</legend>
        {field(`${prefix}Date`, t("events.date"), v.date, {
          type: "date",
          required: options.required ?? false,
        })}
        {field(`${prefix}Time`, t("events.time"), v.time, { type: "time" })}
        {options.hint ? <p className="col-span-2 text-xs text-muted">{options.hint}</p> : null}
      </fieldset>
    );
  };
  const saved = values.questions ?? [];
  const filled = Math.max(saved.length, filledRows(draft, "q", "label", EVENT_QUESTIONS_MAX));
  const questionRow = (i: number) => {
    const q: EventQuestion | undefined = saved[i];
    const name = (f: string) => `q.${i}.${f}`;
    return (
      <div className="grid gap-2 rounded-md border border-border p-3 sm:grid-cols-6">
        <input type="hidden" name={name("id")} value={fromDraft(draft, name("id"), q?.id)} />
        <label className="block space-y-1 sm:col-span-3">
          <span className="text-sm">{t("events.questionLabel")}</span>
          <input
            name={name("label")}
            className={inputClass}
            defaultValue={fromDraft(draft, name("label"), q?.label)}
            maxLength={200}
            data-testid="question-label"
          />
        </label>
        <label className="block space-y-1 sm:col-span-2">
          <span className="text-sm">{t("events.questionType")}</span>
          <select
            name={name("type")}
            className={inputClass}
            defaultValue={fromDraft(draft, name("type"), q?.type ?? "short_text") || "short_text"}
            data-testid="question-type"
          >
            {QUESTION_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(enumKey("events.questionTypes", type))}
              </option>
            ))}
          </select>
        </label>
        {field(name("order"), t("events.questionOrder"), i + 1, { type: "number", min: 1 })}
        <label className="block space-y-1 sm:col-span-4">
          <span className="text-sm">{t("events.questionOptions")}</span>
          <textarea
            name={name("options")}
            rows={2}
            className={inputClass}
            defaultValue={fromDraft(draft, name("options"), q?.options?.join("\n"))}
          />
        </label>
        <div className="space-y-1 text-sm sm:col-span-2">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              name={name("required")}
              defaultChecked={checked(draft, name("required"), q?.required ?? false)}
            />
            {t("events.questionRequired")}
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              name={name("sensitive")}
              defaultChecked={checked(draft, name("sensitive"), q?.sensitive ?? false)}
              data-testid="question-sensitive"
            />
            {t("events.questionSensitive")}
          </label>
          {q ? (
            <noscript>
              <label className="flex items-center gap-2">
                <input type="checkbox" name={name("remove")} />
                {t("events.questionRemove")}
              </label>
            </noscript>
          ) : null}
        </div>
      </div>
    );
  };
  const periodError = error === "event_period_invalid";

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
            defaultValue={fromDraft(draft, "description", values.description)}
          />
        </label>
        {moment("start", t("events.starts"), values.startsAt, {
          required: true,
          hint: t("events.startHint"),
        })}
        {moment("end", t("events.ends"), values.endsAt, { hint: t("events.endHint") })}
        <EventPeriodCheck
          texts={{
            endBeforeStart: t("events.endBeforeStart"),
            closesAfterEnd: t("events.closesAfterEnd"),
          }}
        />
        {periodError ? (
          <p
            role="alert"
            className="text-sm text-danger sm:col-span-2"
            data-testid="event-period-server"
          >
            {t("joinErrors.event_period_invalid")}
          </p>
        ) : null}
        <label className="block space-y-1">
          <span className="text-sm">{t("activities.location")}</span>
          <select
            name="locationId"
            className={inputClass}
            defaultValue={fromDraft(draft, "locationId", values.locationId)}
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
        {field("locationText", t("activities.locationText"), values.locationText, {
          maxLength: 200,
        })}
        <p className="text-xs text-muted sm:col-span-2">
          {t("activities.timeZoneHint", { zone: timeZone })}
        </p>
      </div>

      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-1 text-lg font-semibold">{t("events.signUp")}</legend>
        {moment("opens", t("events.opens"), values.registrationOpensAt, {
          hint: t("events.opensHint"),
        })}
        {moment("closes", t("events.closesField"), values.registrationClosesAt, {
          hint: t("events.closesHint"),
        })}
        {moment("cancel", t("events.cancelDeadline"), values.cancellationClosesAt, {
          hint: t("events.cancelHint"),
        })}
        {field("capacity", t("events.capacity"), values.capacity, {
          type: "number",
          min: 1,
          placeholder: t("events.capacityHint"),
        })}
        <label className="block space-y-1">
          <span className="text-sm">{t("events.waitlistMode")}</span>
          <select
            name="waitlistMode"
            className={inputClass}
            defaultValue={fromDraft(draft, "waitlistMode", values.waitlistMode)}
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

      <section className="space-y-3" data-testid="event-questions">
        <h2 className="mb-1 text-lg font-semibold">{t("events.questions")}</h2>
        <p className="text-sm text-muted">{t("events.questionsHint")}</p>
        <RowList
          rows={Array.from({ length: EVENT_QUESTIONS_MAX }, (_, i) => questionRow(i))}
          initial={initialRows(filled, questionRows, EVENT_QUESTIONS_MAX)}
          countName="qrows"
          texts={{ add: t("events.addQuestion"), remove: t("events.removeRow") }}
          testId="questions"
          fallback={
            <button
              type="submit"
              name="more"
              value="qrows"
              className={secondaryButtonClass}
              data-testid="event-add-question"
            >
              {t("events.addQuestion")}
            </button>
          }
        />
      </section>
    </div>
  );
}

/** The sessions of a new group event: kind ("Other" asks what it is), title, date and times. */
export async function EventSessions({
  draft = null,
  sessionRows,
}: {
  draft?: FormDraft | null;
  sessionRows?: unknown;
}) {
  const t = await getTranslations();
  const filled = filledRows(draft, "a", "title", EVENT_ACTIVITIES_MAX);
  const row = (i: number) => {
    const name = (f: string) => `a.${i}.${f}`;
    const value = (f: string, fallback = "") => fromDraft(draft, name(f), fallback);
    return (
      <div className="group grid gap-2 sm:grid-cols-6" data-testid="session-row">
        <select
          name={name("kind")}
          className={inputClass}
          defaultValue={value("kind", "match") || "match"}
          aria-label={t("activities.kind")}
          data-testid="session-kind"
        >
          {ACTIVITY_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(enumKey("activityKinds", k))}
            </option>
          ))}
        </select>
        <input
          name={name("kindLabel")}
          className={`${inputClass} hidden group-has-[option[value=other]:checked]:block`}
          placeholder={t("activities.kindLabel")}
          aria-label={t("activities.kindLabel")}
          defaultValue={value("kindLabel")}
          maxLength={60}
          data-testid="session-kindLabel"
        />
        <input
          name={name("title")}
          className={inputClass}
          placeholder={t("activities.titleField")}
          aria-label={t("activities.titleField")}
          defaultValue={value("title")}
          maxLength={120}
          data-testid="session-title"
        />
        <input
          name={name("date")}
          type="date"
          className={inputClass}
          aria-label={t("activities.date")}
          defaultValue={value("date")}
          data-testid="session-date"
        />
        <input
          name={name("startTime")}
          type="time"
          className={inputClass}
          aria-label={t("activities.startTime")}
          defaultValue={value("startTime")}
          data-testid="session-start"
        />
        <input
          name={name("endTime")}
          type="time"
          className={inputClass}
          aria-label={t("activities.endTime")}
          defaultValue={value("endTime")}
          data-testid="session-end"
        />
      </div>
    );
  };
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">{t("events.sessions")}</h2>
      <p className="text-sm text-muted">{t("events.sessionsHint")}</p>
      <RowList
        rows={Array.from({ length: EVENT_ACTIVITIES_MAX }, (_, i) => row(i))}
        initial={initialRows(filled, sessionRows, EVENT_ACTIVITIES_MAX)}
        countName="srows"
        texts={{ add: t("events.addSession"), remove: t("events.removeRow") }}
        testId="sessions"
        fallback={
          <button
            type="submit"
            name="more"
            value="srows"
            className={secondaryButtonClass}
            data-testid="event-add-session"
          >
            {t("events.addSession")}
          </button>
        }
      />
    </section>
  );
}
