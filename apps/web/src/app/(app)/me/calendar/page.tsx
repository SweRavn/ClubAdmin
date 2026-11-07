// SPDX-License-Identifier: AGPL-3.0-only
// Calendar subscriptions (P1.11, ADR 0044): create one for my schedule and
// chosen children (or all of them, also later ones), see a new feed's URL
// once (https and webcal, with copy and "Open in calendar"), the warning and
// help per calendar app; then the list with rename, new link and remove.
// Group and club feeds are created from the group page and the club
// calendar and are listed here too. Forms only, so it works without
// JavaScript (the copy button needs it, the URL stays selectable).
import { enumKey } from "@clubadmin/i18n";
import type { PersonSummary } from "@clubadmin/shared";
import { formatDateTime, personLabel, PersonName } from "@clubadmin/ui";
import { cookies } from "next/headers";
import { getLocale, getTimeZone, getTranslations } from "next-intl/server";

import {
  ActionForm,
  buttonClass,
  secondaryButtonClass,
} from "../../../../components/action-form.tsx";
import { CopyButton } from "../../../../components/copy-button.tsx";
import { FormError, Notice } from "../../../../components/form-error.tsx";
import { CALENDAR_URL_COOKIE } from "../../../../server/cookies.ts";
import { getCalendarFeeds, getSchedule, requireSession } from "../../../../server/data.ts";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const inputClass = "w-full rounded-md border border-border bg-bg px-3 py-2";

export async function generateMetadata() {
  return { title: (await getTranslations())("calendar.ui.title") };
}

/** The URLs of a feed just created or given a new link (the cookie of app/actions/calendar-feed). */
function createdUrls(raw: string | undefined): { httpsUrl: string; webcalUrl: string } | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { httpsUrl?: unknown; webcalUrl?: unknown };
    return typeof value.httpsUrl === "string" &&
      typeof value.webcalUrl === "string" &&
      /^https:\/\//.test(value.httpsUrl) &&
      /^webcal:\/\//.test(value.webcalUrl)
      ? { httpsUrl: value.httpsUrl, webcalUrl: value.webcalUrl }
      : null;
  } catch {
    return null;
  }
}

export default async function CalendarSubscriptionsPage({ searchParams }: Props) {
  const today = new Date().toISOString().slice(0, 10);
  const [query, t, locale, timeZone, session, feeds, schedule, jar] = await Promise.all([
    searchParams,
    getTranslations(),
    getLocale(),
    getTimeZone(),
    requireSession(),
    getCalendarFeeds(),
    getSchedule(today, today),
    cookies(),
  ]);
  const created = query.created ? createdUrls(jar.get(CALENDAR_URL_COOKIE)?.value) : null;
  const protectedLabel = t("protected.tooltip");
  // Whose schedule I see: myself and the children whose schedule I may see.
  const people: PersonSummary[] = schedule.people;
  const protectedPeople = people.filter((p) => p.protected);
  const full = feeds.items.length >= feeds.max;

  return (
    <div className="space-y-8" data-testid="calendar-feeds">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">{t("calendar.ui.title")}</h1>
        <p className="text-muted">{t("calendar.ui.intro")}</p>
        <FormError code={query.error} />
        {query.updated ? <Notice>{t("calendar.ui.updated")}</Notice> : null}
        {query.removed ? <Notice>{t("calendar.ui.removed")}</Notice> : null}
      </div>

      {created ? (
        <section
          className="space-y-3 rounded-lg border border-accent bg-accent-soft p-4"
          data-testid="calendar-feed-created"
        >
          <p className="font-semibold">{t("calendar.ui.created")}</p>
          <p role="alert">{t("calendar.ui.warning")}</p>
          {protectedPeople.length > 0 ? (
            <p>
              {t("calendar.ui.protectedWarning", {
                names: protectedPeople.map((p) => personLabel(p)).join(", "),
              })}
            </p>
          ) : null}
          <div className="space-y-1">
            <p className="text-sm font-medium">{t("calendar.ui.webcal")}</p>
            <a
              href={created.webcalUrl}
              className={buttonClass}
              rel="noreferrer"
              data-testid="open-in-calendar"
            >
              {t("calendar.ui.openInCalendar")}
            </a>
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium">{t("calendar.ui.https")}</p>
            <div className="flex flex-wrap items-center gap-2">
              <output
                className="block break-all rounded-md bg-bg px-3 py-2 font-mono text-sm"
                data-testid="calendar-feed-url"
              >
                {created.httpsUrl}
              </output>
              <CopyButton
                text={created.httpsUrl}
                label={t("calendar.ui.copy")}
                done={t("calendar.ui.copied")}
              />
            </div>
          </div>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li>{t("calendar.ui.helpApple")}</li>
            <li>{t("calendar.ui.helpGoogle")}</li>
            <li>{t("calendar.ui.helpOutlook")}</li>
            <li>{t("calendar.ui.helpAndroid")}</li>
          </ul>
        </section>
      ) : null}

      <section
        aria-labelledby="new-feed"
        className="space-y-3 rounded-lg border border-border bg-raised p-4"
      >
        <h2 id="new-feed" className="text-lg font-semibold">
          {t("calendar.ui.subscribe")}
        </h2>
        {full ? (
          <p className="text-muted">{t("calendar.ui.max", { max: feeds.max })}</p>
        ) : (
          <form
            method="post"
            action="/actions/calendar-feed"
            className="space-y-3"
            data-testid="calendar-feed-form"
          >
            <input type="hidden" name="csrf" value={session.record.csrf} />
            <input type="hidden" name="target" value="my_schedule" />
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{t("calendar.ui.people")}</legend>
              {people.length > 1 ? (
                <label className="flex items-center gap-2">
                  <input type="checkbox" name="everyone" value="1" defaultChecked />
                  <span>{t("calendar.ui.everyone")}</span>
                </label>
              ) : (
                <input type="hidden" name="everyone" value="1" />
              )}
              {people.length > 1
                ? people.map((p) => (
                    <label key={p.id} className="flex items-center gap-2">
                      <input type="checkbox" name="personId" value={p.id} />
                      <PersonName person={p} protectedLabel={protectedLabel} />
                    </label>
                  ))
                : null}
            </fieldset>
            <label className="block space-y-1">
              <span className="text-sm font-medium">{t("calendar.ui.label")}</span>
              <input name="label" maxLength={60} className={inputClass} autoComplete="off" />
            </label>
            <button type="submit" className={buttonClass} data-testid="create-calendar-feed">
              {t("calendar.ui.create")}
            </button>
          </form>
        )}
      </section>

      <section aria-labelledby="my-feeds" className="space-y-3">
        <h2 id="my-feeds" className="text-lg font-semibold">
          {t("calendar.ui.list")}
        </h2>
        {feeds.items.length === 0 ? <p className="text-muted">{t("calendar.ui.empty")}</p> : null}
        <ul className="divide-y divide-border rounded-lg border border-border">
          {feeds.items.map((f) => (
            <li key={f.id} className="space-y-2 px-4 py-3" data-testid="calendar-feed">
              <div className="flex flex-wrap items-center gap-2">
                <strong>{f.label ?? t(enumKey("calendar.ui.scopes", f.scope))}</strong>
                <span className="text-sm text-muted">
                  {f.group?.name ??
                    f.club?.name ??
                    (f.everyone ? t("calendar.ui.everyoneShort") : "")}
                </span>
                {f.people.map((p) => (
                  <PersonName key={p.id} person={p} protectedLabel={protectedLabel} />
                ))}
              </div>
              <p className="text-sm text-muted">
                {f.lastFetchedAt
                  ? t("calendar.ui.lastFetched", {
                      date: formatDateTime(f.lastFetchedAt, { locale, timeZone }),
                    })
                  : t("calendar.ui.neverFetched")}
              </p>
              <div className="flex flex-wrap items-end gap-2">
                <ActionForm action="rename-calendar-feed" className="flex items-end gap-2">
                  <input type="hidden" name="feedId" value={f.id} />
                  <label className="block space-y-1">
                    <span className="sr-only">{t("calendar.ui.label")}</span>
                    <input
                      name="label"
                      maxLength={60}
                      defaultValue={f.label ?? ""}
                      className={inputClass}
                    />
                  </label>
                  <button type="submit" className={secondaryButtonClass}>
                    {t("calendar.ui.rename")}
                  </button>
                </ActionForm>
                <form method="post" action="/actions/calendar-feed">
                  <input type="hidden" name="csrf" value={session.record.csrf} />
                  <input type="hidden" name="target" value="regenerate" />
                  <input type="hidden" name="targetId" value={f.id} />
                  <button
                    type="submit"
                    className={secondaryButtonClass}
                    title={t("calendar.ui.regenerateHint")}
                    data-testid="regenerate-calendar-feed"
                  >
                    {t("calendar.ui.regenerate")}
                  </button>
                </form>
                <ActionForm action="remove-calendar-feed">
                  <input type="hidden" name="feedId" value={f.id} />
                  <button
                    type="submit"
                    className={secondaryButtonClass}
                    data-testid="remove-calendar-feed"
                  >
                    {t("calendar.ui.remove")}
                  </button>
                </ActionForm>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
