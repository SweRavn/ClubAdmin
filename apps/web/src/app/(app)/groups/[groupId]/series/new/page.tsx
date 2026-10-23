// SPDX-License-Identifier: AGPL-3.0-only
// A new weekly series of trainings (P1.4). First a preview (a GET form: the
// sessions it would have, with skipped dates and public holidays), then the
// same fields, prefilled, create it. Works without client JavaScript.
import { formatDateTime } from "@clubadmin/ui";
import { forbidden } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import {
  ActionForm,
  buttonClass,
  secondaryButtonClass,
} from "../../../../../../components/action-form.tsx";
import { weekRange } from "../../../../../../components/agenda.tsx";
import { FormError } from "../../../../../../components/form-error.tsx";
import {
  SeriesFields,
  seriesValuesFromQuery,
} from "../../../../../../components/series-fields.tsx";
import {
  getClub,
  getGroup,
  getGroupCalendar,
  getLocations,
  previewSeries,
} from "../../../../../../server/data.ts";

type Props = {
  params: Promise<{ groupId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("series.newTitle") };
}

export default async function NewSeriesPage({ params, searchParams }: Props) {
  const [{ groupId }, query] = await Promise.all([params, searchParams]);
  const { from, to } = weekRange(0, 1);
  const [t, locale, group, calendar] = await Promise.all([
    getTranslations(),
    getLocale(),
    getGroup(groupId),
    getGroupCalendar(groupId, from, to),
  ]);
  if (!calendar.canManage) forbidden();
  const [club, locations] = await Promise.all([getClub(group.clubId), getLocations(group.clubId)]);
  const values = seriesValuesFromQuery(query);
  const asked = query.preview !== undefined;
  const preview =
    asked && values.slots.length > 0 && values.startsOn && values.endsOn
      ? await previewSeries(group.id, {
          slots: values.slots,
          startsOn: values.startsOn,
          endsOn: values.endsOn,
          skipDates: [...(values.skipDates ?? [])],
          skipPublicHolidays: values.skipPublicHolidays ?? true,
        })
      : asked
        ? { error: "invalid_input" }
        : null;
  const when = (iso: string) =>
    formatDateTime(iso, { locale, timeZone: club.timeZone, dateStyle: "full", timeStyle: "short" });
  const day = (date: string) =>
    formatDateTime(`${date}T12:00:00Z`, { locale, timeZone: "UTC", dateStyle: "full" });

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">
        <a href={`/groups/${group.id}`} className="underline">
          {group.name}
        </a>
      </p>
      <h1 className="text-2xl font-semibold">{t("series.newTitle")}</h1>
      <p>{t("series.intro")}</p>
      <FormError code={preview && "error" in preview ? preview.error : query.error} />

      {preview && !("error" in preview) ? (
        <>
          <section aria-labelledby="series-preview" className="space-y-2">
            <h2 id="series-preview" className="text-lg font-semibold">
              {t("series.preview", { count: preview.sessions.length })}
            </h2>
            <ul
              className="max-h-72 overflow-y-auto rounded-lg border border-border text-sm"
              data-testid="series-preview"
            >
              {preview.sessions.map((s) => (
                <li key={s.date} className="border-b border-border px-3 py-1 last:border-0">
                  {when(s.startsAt)}
                </li>
              ))}
            </ul>
            {preview.skipped.length > 0 ? (
              <p className="text-sm text-muted" data-testid="series-skipped">
                {t("series.skipped")}{" "}
                {preview.skipped
                  .map((s) => (s.holiday ? `${day(s.date)} (${t("series.holiday")})` : day(s.date)))
                  .join("; ")}
              </p>
            ) : null}
          </section>
          <ActionForm action="create-series" className="space-y-4" testId="new-series-form">
            <input type="hidden" name="groupId" value={group.id} />
            <input type="hidden" name="kind" value="training" />
            <SeriesFields timeZone={club.timeZone} locations={locations} values={values} />
            <button type="submit" className={buttonClass} data-testid="series-create">
              {t("series.create", { count: preview.sessions.length })}
            </button>
          </ActionForm>
        </>
      ) : (
        <form method="get" className="space-y-4" data-testid="series-preview-form">
          <input type="hidden" name="preview" value="1" />
          <SeriesFields timeZone={club.timeZone} locations={locations} values={values} />
          <button
            type="submit"
            className={secondaryButtonClass}
            data-testid="series-preview-button"
          >
            {t("series.previewButton")}
          </button>
        </form>
      )}
    </div>
  );
}
