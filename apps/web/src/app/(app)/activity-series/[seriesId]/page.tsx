// SPDX-License-Identifier: AGPL-3.0-only
// A series (P1.4): its rules and coming sessions; for those who manage it,
// "change from a date" (sessions from then on follow, detached ones keep
// their changes) and, from a session's page, "this and following" (a new
// series takes over from that session).
import { isUuid, localDate } from "@clubadmin/shared";
import { formatDateTime } from "@clubadmin/ui";
import { getLocale, getTranslations } from "next-intl/server";

import { ActionForm, buttonClass, inputClass } from "../../../../components/action-form.tsx";
import { Agenda, agendaItemOf } from "../../../../components/agenda.tsx";
import { FormError, Notice } from "../../../../components/form-error.tsx";
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
  const weekday = (n: number) =>
    new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(
      new Date(Date.UTC(2024, 0, n)),
    );
  const day = (date: string) =>
    formatDateTime(`${date}T12:00:00Z`, { locale, timeZone: "UTC", dateStyle: "long" });
  const values = {
    title: series.title,
    slots: series.slots,
    endsOn: series.endsOn,
    skipDates: series.skipDates,
    skipPublicHolidays: series.skipPublicHolidays,
    locationId: series.location?.id ?? null,
    locationText: series.locationText,
    notes: series.notes,
    leaderNotes: series.leaderNotes ?? null,
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
      {query.saved ? <Notice>{t("series.saved")}</Notice> : null}
      {query.updated ? <Notice>{t("series.updated")}</Notice> : null}
      <FormError code={query.error} />
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2" data-testid="series-rules">
        <dt className="text-muted">{t("series.slots")}</dt>
        <dd>
          <ul>
            {series.slots.map((s) => (
              <li key={s.weekday}>
                {t("series.slotLine", {
                  weekday: weekday(s.weekday),
                  time: s.startTime,
                  minutes: s.durationMinutes,
                })}
              </li>
            ))}
          </ul>
        </dd>
        <dt className="text-muted">{t("series.period")}</dt>
        <dd>
          {day(series.startsOn)} – {day(series.endsOn)}
        </dd>
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
            <dt className="text-muted">{t("series.skipDates")}</dt>
            <dd>{series.skipDates.map(day).join("; ")}</dd>
          </>
        ) : null}
      </dl>

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
