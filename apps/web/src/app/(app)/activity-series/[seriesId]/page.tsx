// SPDX-License-Identifier: AGPL-3.0-only
// A series (P1.4, P1.14): how it repeats in plain language, its coming
// sessions and removed dates; for those who manage it, removing a date or a
// range (and bringing one back), "change from a date" (sessions from then on
// follow, detached ones keep their changes; also switching between an end
// date and until further notice) and, from a session's page, "this and
// following" (a new series takes over from that session).
import { isUuid, localDate } from "@clubadmin/shared";
import { formatDateTime } from "@clubadmin/ui";
import { getLocale, getTranslations } from "next-intl/server";

import { ActionForm, buttonClass, inputClass } from "../../../../components/action-form.tsx";
import { Agenda, agendaItemOf } from "../../../../components/agenda.tsx";
import { FormError, Notice } from "../../../../components/form-error.tsx";
import { HistoryLink } from "../../../../components/history-view.tsx";
import { recurrenceText, requestLeadText } from "../../../../components/recurrence-summary.ts";
import { SeriesFields } from "../../../../components/series-fields.tsx";
import { getActivity, getGroupCalendar, getLocations, getSeries } from "../../../../server/data.ts";

type Props = {
  params: Promise<{ seriesId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props) {
  return { title: (await getSeries((await params).seriesId)).title };
}

export default async function SeriesPage({ params, searchParams }: Props) {
  const [{ seriesId }, query] = await Promise.all([params, searchParams]);
  const [t, locale, series] = await Promise.all([
    getTranslations(),
    getLocale(),
    getSeries(seriesId),
  ]);
  const zone = series.timeZone;
  const today = localDate(new Date(), zone);
  const split =
    series.canManage && typeof query.split === "string" && isUuid(query.split)
      ? await getActivity(query.split)
      : null;
  const splitDate =
    split?.seriesId === series.id ? localDate(new Date(split.startsAt), zone) : null;
  const [locations, calendar] = await Promise.all([
    series.canManage ? getLocations(series.clubId, true) : Promise.resolve([]),
    series.groups[0]
      ? getGroupCalendar(
          series.groups[0].id,
          new Date().toISOString(),
          new Date(`${series.endsOn}T23:59:59Z`).getTime() > Date.now()
            ? new Date(Date.parse(`${series.endsOn}T00:00:00Z`) + 2 * 86_400_000).toISOString()
            : new Date(Date.now() + 86_400_000).toISOString(),
        )
      : Promise.resolve(null),
  ]);
  const sessions = (calendar?.items ?? []).filter((a) => a.seriesId === series.id).slice(0, 12);
  const day = (date: string) =>
    formatDateTime(`${date}T12:00:00Z`, { locale, timeZone: "UTC", dateStyle: "long" });
  const openEnded = series.openEnded === true;
  const rule = series.rule ?? { freq: "weekly" as const, interval: 1 };
  const summary = await recurrenceText({
    rule,
    slots: series.slots,
    endsOn: openEnded ? null : series.endsOn,
  });
  const removable = series.skipDates.filter((d) => d >= today);
  const values = {
    title: series.title,
    rule,
    slots: series.slots,
    endsOn: openEnded ? null : series.endsOn,
    requestLead: series.requestLead ?? null,
    skipDates: series.skipDates,
    skipPublicHolidays: series.skipPublicHolidays,
    locationId: series.location?.id ?? null,
    locationText: series.locationText,
    notes: series.notes,
    leaderNotes: series.leaderNotes ?? null,
    responseMode: series.responseMode ?? null,
    respondByHours:
      series.respondByMinutes === null || series.respondByMinutes === undefined
        ? null
        : series.respondByMinutes / 60,
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">
        {series.groups.map((g, i) => (
          <span key={g.id}>
            {i > 0 ? ", " : null}
            <a href={`/groups/${g.id}`} className="underline">
              {g.name}
            </a>
          </span>
        ))}
      </p>
      <h1 className="text-2xl font-semibold" data-testid="series-title-heading">
        {series.title}
      </h1>
      <HistoryLink clubId={series.clubId} href={`/activity-series/${series.id}/history`} />
      {query.saved ? <Notice>{t("series.saved")}</Notice> : null}
      {query.updated ? <Notice>{t("series.updated")}</Notice> : null}
      {query.removed ? <Notice>{t("series.datesRemoved")}</Notice> : null}
      {query.restored ? <Notice>{t("series.dateRestored")}</Notice> : null}
      <FormError code={query.error} />
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2" data-testid="series-rules">
        <dt className="text-muted">{t("series.rule")}</dt>
        <dd data-testid="series-summary">{summary}</dd>
        <dt className="text-muted">{t("series.period")}</dt>
        <dd>
          {day(series.startsOn)} – {openEnded ? t("series.untilFurtherNotice") : day(series.endsOn)}
        </dd>
        {series.requestLead ? (
          <>
            <dt className="text-muted">{t("series.request")}</dt>
            <dd data-testid="series-request">{await requestLeadText(series.requestLead)}</dd>
          </>
        ) : null}
        {series.location || series.locationText ? (
          <>
            <dt className="text-muted">{t("activities.where")}</dt>
            <dd>{series.location?.name ?? series.locationText}</dd>
          </>
        ) : null}
        <dt className="text-muted">{t("series.sessions")}</dt>
        <dd data-testid="series-sessions">{series.sessions}</dd>
        {series.skipPublicHolidays ? (
          <>
            <dt className="text-muted">{t("series.holidays")}</dt>
            <dd>{t("series.holidaysSkipped")}</dd>
          </>
        ) : null}
        {series.skipDates.length > 0 ? (
          <>
            <dt className="text-muted">{t("series.removed")}</dt>
            <dd>
              <ul className="space-y-1" data-testid="series-removed-dates">
                {series.skipDates.map((d) => (
                  <li key={d} className="flex flex-wrap items-center gap-2">
                    <span>{day(d)}</span>
                    {series.canManage && removable.includes(d) ? (
                      <ActionForm action="restore-series-date" className="inline">
                        <input type="hidden" name="seriesId" value={series.id} />
                        <input type="hidden" name="date" value={d} />
                        <button
                          type="submit"
                          className="text-sm underline"
                          data-testid={`series-bring-back-${d}`}
                        >
                          {t("series.bringBack")}
                        </button>
                      </ActionForm>
                    ) : null}
                  </li>
                ))}
              </ul>
            </dd>
          </>
        ) : null}
      </dl>

      {series.canManage ? (
        <details className="rounded-lg border border-border p-3">
          <summary className="cursor-pointer font-medium" data-testid="series-remove-dates">
            {t("series.removeDates")}
          </summary>
          <ActionForm
            action="skip-series-dates"
            className="mt-3 space-y-3"
            testId="series-remove-dates-form"
          >
            <input type="hidden" name="seriesId" value={series.id} />
            <p className="text-sm">{t("series.removeDatesIntro")}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="text-sm">{t("series.removeFrom")}</span>
                <input
                  type="date"
                  name="from"
                  min={today}
                  required
                  className={inputClass}
                  data-testid="series-remove-from"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-sm">{t("series.removeTo")}</span>
                <input
                  type="date"
                  name="to"
                  min={today}
                  className={inputClass}
                  data-testid="series-remove-to"
                />
              </label>
            </div>
            <button type="submit" className={buttonClass} data-testid="series-remove-dates-button">
              {t("series.removeButton")}
            </button>
          </ActionForm>
        </details>
      ) : null}

      <section aria-labelledby="series-coming">
        <h2 id="series-coming" className="mb-2 text-lg font-semibold">
          {t("series.coming")}
        </h2>
        <Agenda
          items={sessions.map(agendaItemOf)}
          emptyText={t("series.noneComing")}
          testId="series-agenda"
        />
      </section>

      {series.canManage && split && splitDate ? (
        <section aria-labelledby="series-split" className="space-y-3">
          <h2 id="series-split" className="text-lg font-semibold">
            {t("series.splitTitle", { date: day(splitDate) })}
          </h2>
          <p className="text-sm">{t("series.splitIntro")}</p>
          <ActionForm action="split-series" className="space-y-4" testId="series-split-form">
            <input type="hidden" name="seriesId" value={series.id} />
            <input type="hidden" name="activityId" value={split.id} />
            <SeriesFields timeZone={zone} locations={locations} values={values} withStart={false} />
            <button type="submit" className={buttonClass} data-testid="series-split">
              {t("series.split")}
            </button>
          </ActionForm>
        </section>
      ) : series.canManage ? (
        <details className="rounded-lg border border-border p-3">
          <summary className="cursor-pointer font-medium" data-testid="series-edit">
            {t("series.edit")}
          </summary>
          <ActionForm action="update-series" className="mt-3 space-y-4" testId="series-edit-form">
            <input type="hidden" name="seriesId" value={series.id} />
            <label className="block space-y-1">
              <span className="text-sm">{t("series.from")}</span>
              <input
                type="date"
                name="from"
                min={today}
                defaultValue={today}
                className={inputClass}
                data-testid="series-from"
              />
              <span className="text-xs text-muted">{t("series.fromHint")}</span>
            </label>
            <SeriesFields timeZone={zone} locations={locations} values={values} withStart={false} />
            <button type="submit" className={buttonClass} data-testid="series-save">
              {t("series.save")}
            </button>
          </ActionForm>
        </details>
      ) : null}
    </div>
  );
}
