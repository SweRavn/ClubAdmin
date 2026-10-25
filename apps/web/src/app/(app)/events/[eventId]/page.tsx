// SPDX-License-Identifier: AGPL-3.0-only
// An event (P1.6): details, its activities, places left, my family with
// "Sign up" / "Change answers" / "Cancel" / "Accept" / "Decline" and the
// status per person; for organisers the registrations with answers, "Move
// up" and "Remove" with a reason, and the CSV export. Sensitive answers
// reach only those the API unseals them for. Works without client
// JavaScript.
import { enumKey } from "@clubadmin/i18n";
import { PersonName } from "@clubadmin/ui";
import { getTranslations } from "next-intl/server";

import {
  ActionForm,
  buttonClass,
  inputClass,
  secondaryButtonClass,
} from "../../../../components/action-form.tsx";
import { ClubTime } from "../../../../components/club-time.tsx";
import { answerText, EventQuestions } from "../../../../components/event-questions.tsx";
import { FormError, Notice } from "../../../../components/form-error.tsx";
import { getEvent, getEventRegistrations } from "../../../../server/data.ts";

type Props = {
  params: Promise<{ eventId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props) {
  return { title: (await getEvent((await params).eventId)).title };
}

const OPEN = ["confirmed", "waitlisted", "offered"];

export default async function EventPage({ params, searchParams }: Props) {
  const [{ eventId }, query] = await Promise.all([params, searchParams]);
  const [t, event] = await Promise.all([getTranslations(), getEvent(eventId)]);
  const registrations = await getEventRegistrations(event.id);
  const protectedLabel = t("protected.tooltip");
  const yes = t("events.yes");
  const no = t("events.no");
  const time = (value: string) => (
    <ClubTime value={value} timeZone={event.timeZone} dateStyle="medium" timeStyle="short" />
  );
  const status = (r: {
    status: string;
    position: number | null;
    offerExpiresAt: string | null;
  }) => {
    if (r.status === "waitlisted" && r.position !== null) {
      return t("events.position", { position: r.position });
    }
    return t(enumKey("events.registrationStatus", r.status));
  };

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold" data-testid="event-title">
          {event.title}
        </h1>
        <p className="text-muted">
          {time(event.startsAt)} – {time(event.endsAt)}
          {event.location
            ? ` · ${event.location.name}`
            : event.locationText
              ? ` · ${event.locationText}`
              : ""}
        </p>
        {event.groups.length > 0 ? (
          <p className="text-sm text-muted">{event.groups.map((g) => g.name).join(", ")}</p>
        ) : (
          <p className="text-sm text-muted">{t("events.audienceClub")}</p>
        )}
      </div>
      {query.saved ? <Notice>{t("events.saved")}</Notice> : null}
      {query.updated ? <Notice>{t("events.updated")}</Notice> : null}
      <FormError code={query.error} />
      {event.status === "draft" ? <p className="font-medium">{t("events.draftHint")}</p> : null}
      {event.status === "cancelled" ? (
        <p className="font-medium" data-testid="event-cancelled">
          {t("events.cancelledHint")}
          {event.cancelledReason ? `: ${event.cancelledReason}` : ""}
        </p>
      ) : null}
      {event.description ? <p className="whitespace-pre-line">{event.description}</p> : null}

      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted">{t("events.closesField")}</dt>
        <dd>{time(event.registrationClosesAt)}</dd>
        {event.registrationOpensAt ? (
          <>
            <dt className="text-muted">{t("events.opens")}</dt>
            <dd>{time(event.registrationOpensAt)}</dd>
          </>
        ) : null}
        {event.priceText ? (
          <>
            <dt className="text-muted">{t("events.priceText")}</dt>
            <dd>{event.priceText}</dd>
          </>
        ) : null}
        <dt className="text-muted">{t("events.places")}</dt>
        <dd data-testid="event-counts">
          {event.counts.placesLeft === null
            ? t("events.countsUnlimited", { confirmed: event.counts.confirmed })
            : t("events.counts", {
                confirmed: event.counts.confirmed,
                left: event.counts.placesLeft,
                waiting: event.counts.waiting,
              })}
        </dd>
      </dl>

      {event.activities.length > 0 ? (
        <section aria-labelledby="event-activities" className="space-y-2">
          <h2 id="event-activities" className="text-lg font-semibold">
            {t("events.sessions")}
          </h2>
          <ul className="space-y-1">
            {event.activities.map((a) => (
              <li key={a.id}>
                <a href={`/activities/${a.id}`} className="underline">
                  {a.title}
                </a>{" "}
                <span className="text-sm text-muted">{time(a.startsAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {event.mine.length > 0 ? (
        <section aria-labelledby="event-mine" className="space-y-4" data-testid="event-mine">
          <h2 id="event-mine" className="text-lg font-semibold">
            {t("events.mine")}
          </h2>
          {event.mine.map((m) => {
            const reg = m.registration;
            const open = reg !== null && OPEN.includes(reg.status);
            const answers = { ...(reg?.answers ?? {}), ...(reg?.sensitiveAnswers ?? {}) };
            return (
              <div
                key={m.person.id}
                className="space-y-3 rounded-lg border border-border bg-raised p-4"
              >
                <p className="flex flex-wrap items-center gap-2">
                  <PersonName person={m.person} protectedLabel={protectedLabel} />
                  {reg ? (
                    <span className="text-sm" data-testid="registration-status">
                      · {status(reg)}
                    </span>
                  ) : null}
                </p>
                {reg?.status === "offered" && reg.offerExpiresAt ? (
                  <div className="space-y-2">
                    <p>
                      {t("events.offerUntil")} {time(reg.offerExpiresAt)}
                    </p>
                    <ActionForm action="answer-offer" className="flex gap-2">
                      <input type="hidden" name="eventId" value={event.id} />
                      <input type="hidden" name="personId" value={m.person.id} />
                      <button
                        type="submit"
                        name="answer"
                        value="accept"
                        className={buttonClass}
                        data-testid="offer-accept"
                      >
                        {t("events.accept")}
                      </button>
                      <button
                        type="submit"
                        name="answer"
                        value="decline"
                        className={secondaryButtonClass}
                        data-testid="offer-decline"
                      >
                        {t("events.decline")}
                      </button>
                    </ActionForm>
                  </div>
                ) : null}
                {m.canRegister && (!reg || open) ? (
                  <details open={!reg}>
                    <summary className="cursor-pointer text-sm underline">
                      {reg ? t("events.changeAnswers") : t("events.signUpFor")}
                    </summary>
                    <ActionForm action="register" className="mt-3 space-y-3" testId="register-form">
                      <input type="hidden" name="eventId" value={event.id} />
                      <input type="hidden" name="personId" value={m.person.id} />
                      <EventQuestions questions={event.questions} answers={answers} />
                      <button type="submit" className={buttonClass} data-testid="register-submit">
                        {reg ? t("events.saveAnswers") : t("events.register")}
                      </button>
                    </ActionForm>
                  </details>
                ) : null}
                {!reg && !m.canRegister ? (
                  <p className="text-sm text-muted">
                    {event.open ? t("events.cannotRegister") : t("events.notOpen")}
                  </p>
                ) : null}
                {open ? (
                  <ActionForm action="cancel-registration">
                    <input type="hidden" name="eventId" value={event.id} />
                    <input type="hidden" name="personId" value={m.person.id} />
                    <button
                      type="submit"
                      className={secondaryButtonClass}
                      data-testid="registration-cancel"
                    >
                      {t("events.cancelRegistration")}
                    </button>
                  </ActionForm>
                ) : null}
              </div>
            );
          })}
        </section>
      ) : null}

      {event.participants ? (
        <section aria-labelledby="event-participants" className="space-y-2">
          <h2 id="event-participants" className="text-lg font-semibold">
            {t("events.participants")}
          </h2>
          {event.participants.length === 0 ? (
            <p className="text-muted">{t("events.noParticipants")}</p>
          ) : (
            <ul className="flex flex-wrap gap-x-4 gap-y-1">
              {event.participants.map((p) => (
                <li key={p.id}>
                  <PersonName person={p} protectedLabel={protectedLabel} />
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {event.canManage ? (
        <section
          aria-labelledby="event-organise"
          className="space-y-3"
          data-testid="event-organise"
        >
          <h2 id="event-organise" className="text-lg font-semibold">
            {t("events.organise")}
          </h2>
          <div className="flex flex-wrap gap-2">
            <a
              href={`/events/${event.id}/edit`}
              className={secondaryButtonClass}
              data-testid="event-edit"
            >
              {t("events.editTitle")}
            </a>
            {event.status === "draft" ? (
              <>
                <ActionForm action="publish-event">
                  <input type="hidden" name="eventId" value={event.id} />
                  <button type="submit" className={buttonClass} data-testid="event-publish-now">
                    {t("events.publish")}
                  </button>
                </ActionForm>
                <ActionForm action="delete-event">
                  <input type="hidden" name="eventId" value={event.id} />
                  <input type="hidden" name="clubId" value={event.clubId} />
                  <button type="submit" className={secondaryButtonClass}>
                    {t("events.delete")}
                  </button>
                </ActionForm>
              </>
            ) : null}
          </div>
          {event.status !== "cancelled" ? (
            <ActionForm action="cancel-event" className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="eventId" value={event.id} />
              <label className="block space-y-1">
                <span className="text-sm">{t("events.cancelReason")}</span>
                <input name="reason" maxLength={300} className={inputClass} />
              </label>
              <button type="submit" className={secondaryButtonClass} data-testid="event-cancel">
                {t("events.cancelEvent")}
              </button>
            </ActionForm>
          ) : null}
        </section>
      ) : null}

      {registrations ? (
        <section aria-labelledby="event-registrations" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="event-registrations" className="text-lg font-semibold">
              {t("events.registrations")}
            </h2>
            <a
              href={`/api/v1/events/${event.id}/registrations.csv`}
              className={secondaryButtonClass}
              data-testid="event-export"
            >
              {t("events.export")}
            </a>
          </div>
          {event.questions.some((q) => q.sensitive) ? (
            <p className="text-sm text-muted">{t("events.sensitiveRetention")}</p>
          ) : null}
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="registrations-table">
              <thead>
                <tr className="text-left">
                  <th className="p-2">{t("events.person")}</th>
                  <th className="p-2">{t("events.status")}</th>
                  {event.questions.map((q) => (
                    <th key={q.id} className="p-2">
                      {q.label}
                    </th>
                  ))}
                  {event.canManage ? <th className="p-2">{t("events.decide")}</th> : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {registrations.items.map((r) => {
                  const answers = { ...r.answers, ...(r.sensitiveAnswers ?? {}) };
                  return (
                    <tr key={r.person.id + r.updatedAt}>
                      <td className="p-2">
                        <PersonName person={r.person} protectedLabel={protectedLabel} />
                      </td>
                      <td className="p-2">{status(r)}</td>
                      {event.questions.map((q) => (
                        <td key={q.id} className="p-2">
                          {answerText(answers[q.id], yes, no)}
                        </td>
                      ))}
                      {event.canManage ? (
                        <td className="p-2">
                          {OPEN.includes(r.status) ? (
                            <ActionForm
                              action="decide-registration"
                              className="flex flex-wrap gap-1"
                            >
                              <input type="hidden" name="eventId" value={event.id} />
                              <input type="hidden" name="personId" value={r.person.id} />
                              <input
                                name="reason"
                                required
                                maxLength={300}
                                placeholder={t("events.reason")}
                                aria-label={t("events.reason")}
                                className={inputClass}
                              />
                              {r.status !== "confirmed" ? (
                                <button
                                  type="submit"
                                  name="decision"
                                  value="confirm"
                                  className={secondaryButtonClass}
                                >
                                  {t("events.moveUp")}
                                </button>
                              ) : null}
                              <button
                                type="submit"
                                name="decision"
                                value="remove"
                                className={secondaryButtonClass}
                              >
                                {t("events.remove")}
                              </button>
                            </ActionForm>
                          ) : r.decisionReason ? (
                            <span className="text-muted">{r.decisionReason}</span>
                          ) : null}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
