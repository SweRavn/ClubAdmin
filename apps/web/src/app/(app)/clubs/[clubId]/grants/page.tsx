// SPDX-License-Identifier: AGPL-3.0-only
// Grant reports (P2.7 part C, ADR 0051): per enabled scheme its periods with
// the deadline and the late steps; a period's report with what counts and
// why (the plugin's texts), the totals, the data to fix first (with a link
// to the person), locking (club.grants.report) and exporting the locked
// report's files. People only through the PersonPresenter (PersonName).
import { enumKey } from "@clubadmin/i18n";
import type { GrantPeriod, GrantReport, GrantSchemeList } from "@clubadmin/shared";
import { formatDateTime, PersonName } from "@clubadmin/ui";
import { forbidden } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import {
  ActionForm,
  buttonClass,
  inputClass,
  secondaryButtonClass,
} from "../../../../../components/action-form.tsx";
import { FormError, Notice } from "../../../../../components/form-error.tsx";
import {
  currentPath,
  getClub,
  getGrantReport,
  getGrantSchemes,
  getMyClubs,
  requireSession,
} from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("grants.title") };
}

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** Today in the club's time zone (YYYY-MM-DD). */
const today = (timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "short" }).format(new Date());

export default async function GrantsPage({ params, searchParams }: Props) {
  const [{ clubId }, query, t, locale] = await Promise.all([
    params,
    searchParams,
    getTranslations(),
    getLocale(),
  ]);
  const [club, mine, schemes] = await Promise.all([
    getClub(clubId),
    getMyClubs(),
    getGrantSchemes(clubId, locale),
  ]);
  const permissions = mine.clubs.find((c) => c.club.id === club.id)?.permissions ?? [];
  if (!permissions.includes("club.grants.read")) forbidden();
  const canReport = permissions.includes("club.grants.report");
  const canPlugins = permissions.includes("club.plugins.manage");
  const day = (d: string) =>
    formatDateTime(`${d}T12:00:00Z`, { locale, timeZone: "UTC", dateStyle: "long" });
  const now = today(club.timeZone);

  const key = {
    pluginId: one(query.pluginId),
    scheme: one(query.scheme),
    period: one(query.period),
  };
  const selected =
    schemes.page?.items.find((s) => s.pluginId === key.pluginId && s.key === key.scheme) ?? null;
  const report =
    selected && selected.periods.some((p) => p.key === key.period)
      ? await getGrantReport(club.id, key, locale)
      : null;

  return (
    <div className="space-y-8" data-testid="grants-page">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{t("grants.title")}</h1>
        <p className="text-muted">{t("grants.intro")}</p>
      </div>
      <FormError code={query.error} />
      {query.locked ? <Notice>{t("grants.lockedNotice")}</Notice> : null}
      {schemes.error ? <FormError code={schemes.error} /> : null}
      {schemes.page && schemes.page.unavailable.length > 0 ? (
        <p role="alert" className="rounded-md bg-protected-soft px-3 py-2">
          {t("grants.unavailable", { plugins: schemes.page.unavailable.join(", ") })}
        </p>
      ) : null}
      {schemes.page && schemes.page.items.length === 0 ? (
        <div className="space-y-2" data-testid="grants-empty">
          <p>{t("grants.none")}</p>
          {canPlugins ? (
            <a href={`/clubs/${club.id}/plugins`} className="text-accent underline">
              {t("plugins.title")}
            </a>
          ) : null}
        </div>
      ) : null}
      {schemes.page ? (
        <Schemes schemes={schemes.page} clubId={club.id} now={now} day={day} selected={key} />
      ) : null}
      {report?.error ? <FormError code={report.error} /> : null}
      {report?.page && selected ? (
        <Report
          report={report.page}
          clubId={club.id}
          formats={selected.formats}
          canReport={canReport}
          day={day}
        />
      ) : null}
    </div>
  );
}

async function Schemes({
  schemes,
  clubId,
  now,
  day,
  selected,
}: {
  schemes: GrantSchemeList;
  clubId: string;
  now: string;
  day: (d: string) => string;
  selected: { pluginId: string; scheme: string; period: string };
}) {
  const t = await getTranslations();
  const deadlineText = (p: GrantPeriod) => {
    if (p.refusedAfter && now > p.refusedAfter) return t("grants.refused");
    const late = p.late.find((l) => now > p.deadline && now <= l.until);
    if (late) return t("grants.late", { percent: late.percent, until: day(late.until) });
    return t("grants.deadline", { date: day(p.deadline) });
  };
  return (
    <section className="space-y-4" aria-labelledby="grant-schemes">
      <h2 id="grant-schemes" className="sr-only">
        {t("grants.schemes")}
      </h2>
      {schemes.items.map((s) => (
        <div
          key={`${s.pluginId}/${s.key}`}
          className="space-y-2 rounded-lg border border-border bg-raised p-4"
          data-testid="grant-scheme"
        >
          <h3 className="text-lg font-semibold">{s.name}</h3>
          <ul className="space-y-1">
            {[...s.periods]
              .sort((a, b) => b.from.localeCompare(a.from))
              .map((p) => {
                const current = p.from <= now && now <= p.to;
                const open =
                  selected.pluginId === s.pluginId &&
                  selected.scheme === s.key &&
                  selected.period === p.key;
                const href = `/clubs/${clubId}/grants?${new URLSearchParams({
                  pluginId: s.pluginId,
                  scheme: s.key,
                  period: p.key,
                })}`;
                return (
                  <li key={p.key} className="flex flex-wrap items-baseline gap-2">
                    <a
                      href={href}
                      className={open ? "font-semibold" : "text-accent underline"}
                      aria-current={open ? "page" : undefined}
                      data-testid={`grant-period-${p.key}`}
                    >
                      {day(p.from)} – {day(p.to)}
                    </a>
                    {current ? (
                      <span className="rounded bg-accent-soft px-2 text-xs">
                        {t("grants.current")}
                      </span>
                    ) : null}
                    {p.from <= now ? (
                      <span className="text-sm text-muted">{deadlineText(p)}</span>
                    ) : null}
                  </li>
                );
              })}
          </ul>
        </div>
      ))}
    </section>
  );
}

async function Report({
  report,
  clubId,
  formats,
  canReport,
  day,
}: {
  report: GrantReport;
  clubId: string;
  formats: string[];
  canReport: boolean;
  day: (d: string) => string;
}) {
  const [t, locale, session, path] = await Promise.all([
    getTranslations(),
    getLocale(),
    requireSession(),
    currentPath(),
  ]);
  const text = (code: string) => report.texts[code] ?? code;
  const protectedLabel = t("protected.tooltip");
  const when = (iso: string) =>
    formatDateTime(iso, { locale, timeZone: "UTC", dateStyle: "medium", timeStyle: "short" });
  const back = new URL(path, "https://internal.invalid");
  back.searchParams.delete("error");
  back.searchParams.delete("locked");
  const counting = report.sessions.filter((s) => s.counts).length;
  return (
    <section className="space-y-6" aria-labelledby="grant-report" data-testid="grant-report">
      <div className="space-y-1">
        <h2 id="grant-report" className="text-xl font-semibold">
          {t("grants.report", { from: day(report.period.from), to: day(report.period.to) })}
        </h2>
        <p data-testid="grant-report-status">
          {t(enumKey("grants.statuses", report.status))}
          {report.lockedAt && report.lockedBy ? (
            <>
              {" · "}
              {t("grants.lockedBy", { at: when(report.lockedAt) })}{" "}
              <PersonName person={report.lockedBy} protectedLabel={protectedLabel} />
            </>
          ) : report.evaluatedAt ? (
            ` · ${t("grants.evaluatedAt", { at: when(report.evaluatedAt) })}`
          ) : null}
        </p>
        {report.attendanceChangedAt ? (
          <p role="alert" className="rounded-md bg-protected-soft px-3 py-2">
            {t("grants.attendanceChanged", { at: when(report.attendanceChangedAt) })}
          </p>
        ) : null}
      </div>

      {report.missing.length > 0 ? (
        <div className="space-y-2" data-testid="grant-missing">
          <h3 className="text-lg font-semibold">{t("grants.missing")}</h3>
          <p className="text-sm text-muted">{t("grants.missingHint")}</p>
          <ul className="space-y-1">
            {report.missing.map((m) => (
              <li key={`${m.person.id}/${m.field}`} className="flex flex-wrap gap-2">
                <PersonName
                  person={m.person}
                  protectedLabel={protectedLabel}
                  href={`/people/${m.person.id}?clubId=${clubId}`}
                />
                <span>· {t(enumKey("plugins.dataFields", m.field))}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {report.totals.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-lg font-semibold">{t("grants.totals")}</h3>
          <table className="w-full text-sm" data-testid="grant-totals">
            <tbody>
              {report.totals.map((total, i) => (
                <tr key={i} className="border-b border-border">
                  <td className="py-1 pr-4">
                    {text(total.measure)}
                    {Object.entries(total.dimensions).length > 0
                      ? ` (${Object.entries(total.dimensions)
                          .map(([k, v]) => `${text(k)}: ${text(v)}`)
                          .join(", ")})`
                      : ""}
                  </td>
                  <td className="py-1 text-right tabular-nums">{total.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {report.sessions.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-lg font-semibold">
            {t("grants.sessions", { counting, total: report.sessions.length })}
          </h3>
          <ul className="space-y-1" data-testid="grant-sessions">
            {report.sessions.map((s) => (
              <li
                key={s.sessionId}
                className="flex flex-wrap gap-2"
                data-testid="grant-session"
                data-counts={s.counts}
              >
                <a href={`/activities/${s.sessionId}`} className="underline">
                  {day(s.date)} · {s.title}
                </a>
                <span className={s.counts ? "" : "text-muted"}>
                  {s.counts ? t("grants.counts", { count: s.counted }) : t("grants.notCounted")}
                </span>
                {s.codes.length > 0 ? (
                  <span className="text-sm text-muted">{s.codes.map(text).join(" · ")}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {report.people.length > 0 ? (
        <details className="space-y-2">
          <summary className="cursor-pointer text-lg font-semibold">
            {t("grants.people", { count: report.people.length })}
          </summary>
          <ul className="space-y-1" data-testid="grant-people">
            {report.people.map((p) => (
              <li key={p.person.id} className="flex flex-wrap gap-2">
                <PersonName person={p.person} protectedLabel={protectedLabel} />
                <span className="tabular-nums">{p.counted}</span>
                {p.codes.length > 0 ? (
                  <span className="text-sm text-muted">{p.codes.map(text).join(" · ")}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {canReport ? (
        report.status === "draft" ? (
          <ActionForm action="grant-report-lock" testId="grant-lock-form">
            <input type="hidden" name="clubId" value={clubId} />
            <input type="hidden" name="reportId" value={report.id} />
            <p className="mb-2 text-sm text-muted">
              {report.missing.length > 0 ? t("grants.lockWithMissing") : t("grants.lockHint")}
            </p>
            <button type="submit" className={buttonClass} data-testid="grant-lock">
              {t("grants.lock")}
            </button>
          </ActionForm>
        ) : (
          <form
            method="post"
            action={`/clubs/${clubId}/grants/reports/${report.id}/export`}
            className="flex flex-wrap items-end gap-2"
            data-testid="grant-export-form"
          >
            <input type="hidden" name="csrf" value={session.record.csrf} />
            <input type="hidden" name="back" value={`${back.pathname}${back.search}`} />
            <label className="block space-y-1">
              <span className="text-sm">{t("grants.format")}</span>
              <select name="format" className={inputClass} data-testid="grant-export-format">
                {formats.map((f) => (
                  <option key={f} value={f}>
                    {f.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className={secondaryButtonClass} data-testid="grant-export">
              {t("grants.export")}
            </button>
          </form>
        )
      ) : null}
    </section>
  );
}
