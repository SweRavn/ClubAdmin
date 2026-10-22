// SPDX-License-Identifier: AGPL-3.0-only
// Exports of the member register (P1.2): choose the columns of the list you
// came from (its filter travels in the URL), and download your own exports
// while they are valid. Every club manager is told about each export.

import { enumKey } from "@clubadmin/i18n";
import { MEMBER_EXPORT_COLUMNS } from "@clubadmin/shared";
import { EmptyState, personLabel } from "@clubadmin/ui";
import { forbidden } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { ActionForm, buttonClass } from "../../../../../../components/action-form.tsx";
import { ClubTime } from "../../../../../../components/club-time.tsx";
import { FormError, Notice } from "../../../../../../components/form-error.tsx";
import { getClub, getMemberExports, getMyClubs } from "../../../../../../server/data.ts";
import { registerParams } from "../../../../../../server/register-query.ts";

type Props = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** Pre-selected columns: what a member list for the board usually needs. */
const DEFAULT_COLUMNS = new Set(["name", "memberNumber", "membershipType", "groups"]);

export async function generateMetadata() {
  return { title: (await getTranslations())("memberExports.title") };
}

export default async function MemberExportsPage({ params, searchParams }: Props) {
  const [{ clubId }, search] = await Promise.all([params, searchParams]);
  const [t, club, mine] = await Promise.all([getTranslations(), getClub(clubId), getMyClubs()]);
  const permissions = mine.clubs.find((c) => c.club.id === club.id)?.permissions ?? [];
  if (!permissions.includes("club.members.export")) forbidden();
  const exports = await getMemberExports(club.id);
  const { sort: _sort, order: _order, ...filter } = registerParams(search, "full");

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">
        <a href={`/clubs/${club.id}/members`} className="underline">
          {t("nav.members")}
        </a>
      </p>
      <h1 className="text-2xl font-semibold">{t("memberExports.title")}</h1>
      <p>{t("memberExports.intro")}</p>
      {search.requested ? <Notice>{t("memberExports.requested")}</Notice> : null}
      <FormError code={search.error} />

      {exports === null ? (
        <p role="alert" className="rounded-md bg-protected-soft px-3 py-2">
          {t("memberExports.mfa")}
        </p>
      ) : (
        <>
          <ActionForm action="create-member-export" className="space-y-4" testId="export-form">
            <input type="hidden" name="clubId" value={club.id} />
            {Object.entries(filter).map(([key, value]) => (
              <input key={key} type="hidden" name={`filter.${key}`} value={value} />
            ))}
            <p className="text-sm text-muted">{t("memberExports.filterNote")}</p>
            <fieldset className="space-y-1">
              <legend className="mb-1 font-medium">{t("memberExports.columns")}</legend>
              <div className="grid gap-1 sm:grid-cols-2">
                {MEMBER_EXPORT_COLUMNS.map((column) => (
                  <label key={column} className="inline-flex items-center gap-2">
                    <input
                      type="checkbox"
                      name="column"
                      value={column}
                      defaultChecked={DEFAULT_COLUMNS.has(column)}
                    />
                    {t(enumKey("memberExport.columns", column))}
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="flex items-start gap-2">
              <input type="checkbox" name="includeProtected" className="mt-1" />
              <span>{t("memberExports.includeProtected")}</span>
            </label>
            <button type="submit" className={buttonClass} data-testid="export-submit">
              {t("memberExports.create")}
            </button>
          </ActionForm>

          <section aria-labelledby="exports-list" className="space-y-2">
            <h2 id="exports-list" className="text-lg font-semibold">
              {t("memberExports.list")}
            </h2>
            {exports.items.length === 0 ? (
              <EmptyState title={t("memberExports.empty")} headingLevel={3} />
            ) : (
              <ul className="divide-y divide-border" data-testid="exports">
                {exports.items.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                    <span>
                      {e.requestedBy ? personLabel(e.requestedBy) : t("memberExports.byProtected")}
                    </span>
                    <span className="text-sm text-muted">
                      <ClubTime value={e.createdAt} timeZone={club.timeZone} />
                    </span>
                    <span className="text-sm text-muted">
                      {e.columns.map((c) => t(enumKey("memberExport.columns", c))).join(", ")}
                    </span>
                    {e.rowCount !== null ? (
                      <span className="text-sm">
                        {t("memberExports.rows", { count: e.rowCount })}
                      </span>
                    ) : null}
                    <span className="text-sm" data-status={e.status}>
                      {t(enumKey("memberExports.status", e.status))}
                    </span>
                    {e.mine && e.status === "ready" ? (
                      <a
                        href={`/clubs/${club.id}/members/exports/${e.id}/download`}
                        className="text-accent underline"
                        data-testid="export-download"
                      >
                        {t("memberExports.download")}
                      </a>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
