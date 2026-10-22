// SPDX-License-Identifier: AGPL-3.0-only
// The member register (P1.2): search as you type, filters with counts,
// sorting and keyset pages. Club managers and registrars see the full
// register (protected members with the crossed-camera icon); board roles a
// limited list. The first page is rendered by the server; further pages load
// in a client list only when there are more.

import { enumKey } from "@clubadmin/i18n";
import {
  CLUB_ROLES,
  CONSENT_PURPOSES,
  GENDERS,
  MEMBERSHIP_TYPES,
  REGISTER_STATUSES,
} from "@clubadmin/shared";
import { EmptyState } from "@clubadmin/ui";
import { forbidden } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { inputClass, secondaryButtonClass } from "../../../../../components/action-form.tsx";
import { LazyRegisterList } from "../../../../../components/lazy-register-list.tsx";
import { RegisterEntry, type RegisterTexts } from "../../../../../components/register-entry.tsx";
import { RegisterSearch } from "../../../../../components/register-search.tsx";
import { getClub, getMyClubs, getRegister, getRegisterFacets } from "../../../../../server/data.ts";
import { registerParams, toQueryString } from "../../../../../server/register-query.ts";

type Props = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const PAGE_SIZE = 50;

export async function generateMetadata() {
  return { title: (await getTranslations())("nav.members") };
}

export default async function MembersPage({ params, searchParams }: Props) {
  const [{ clubId }, search] = await Promise.all([params, searchParams]);
  const [t, club, mine] = await Promise.all([getTranslations(), getClub(clubId), getMyClubs()]);
  const permissions = mine.clubs.find((c) => c.club.id === club.id)?.permissions ?? [];
  if (!permissions.includes("club.members.read")) forbidden();

  const facets = await getRegisterFacets(club.id);
  const full = facets.access === "full";
  const filter = registerParams(search, facets.access);
  const query = toQueryString(filter);
  const page = await getRegister(club.id, toQueryString({ ...filter, limit: String(PAGE_SIZE) }));
  const statuses = new Set((filter.status ?? "").split(",").filter(Boolean));
  // The panel opens when a filter differs from the defaults.
  const filtered = Object.entries(filter).some(
    ([key, value]) =>
      !["q", "sort", "order"].includes(key) && !(key === "status" && value === "active,paused"),
  );

  const texts: RegisterTexts = {
    protectedTooltip: t("protected.tooltip"),
    memberNumber: t("members.memberNumber", { number: "{number}" }),
    born: t("members.born", { date: "{date}" }),
    missingConsents: t("members.missingConsents", { purposes: "{purposes}" }),
    types: Object.fromEntries(MEMBERSHIP_TYPES.map((v) => [v, t(enumKey("membershipTypes", v))])),
    statuses: Object.fromEntries(
      REGISTER_STATUSES.map((v) => [v, t(enumKey("membershipStatus", v))]),
    ),
    consents: Object.fromEntries(
      CONSENT_PURPOSES.map((v) => [v, t(enumKey("consentPurposes", v))]),
    ),
    other: t("common.other"),
  };
  const count = (list: { value: string; count: number }[] | undefined, value: string) =>
    list?.find((f) => f.value === value)?.count ?? 0;
  const select = (name: string, label: string, options: { value: string; label: string }[]) => (
    <label className="block space-y-1">
      <span className="text-sm">{label}</span>
      <select
        name={name}
        defaultValue={filter[name as keyof typeof filter] ?? ""}
        className={inputClass}
      >
        <option value="">{t("members.any")}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">{t("members.title", { club: club.name })}</h1>
        {permissions.includes("club.guardians.manage") ? (
          <a
            href={`/clubs/${club.id}/duplicates`}
            className="text-accent underline"
            data-testid="register-duplicates"
          >
            {t("family.clubDuplicates.title")}
          </a>
        ) : null}
        {permissions.includes("club.members.export") ? (
          <a
            href={`/clubs/${club.id}/members/exports${query ? `?${query}` : ""}`}
            className="text-accent underline"
            data-testid="register-export"
          >
            {t("members.export")}
          </a>
        ) : null}
      </div>
      {!full ? <p className="text-muted">{t("members.limited")}</p> : null}

      <form method="get" role="search" className="space-y-4" data-testid="register-filters">
        <RegisterSearch name="q" defaultValue={filter.q ?? ""} label={t("members.searchLabel")} />
        <details open={filtered}>
          <summary className="cursor-pointer text-sm">{t("members.filters")}</summary>
          <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {full ? (
              <fieldset className="space-y-1">
                <legend className="text-sm">{t("members.status")}</legend>
                {REGISTER_STATUSES.map((s) => (
                  <label key={s} className="mr-3 inline-flex items-center gap-1 text-sm">
                    <input
                      type="checkbox"
                      name="status"
                      value={s}
                      defaultChecked={statuses.size === 0 ? s !== "left" : statuses.has(s)}
                    />
                    {t("members.facet", {
                      label: t(enumKey("membershipStatus", s)),
                      count: count(facets.statuses, s),
                    })}
                  </label>
                ))}
              </fieldset>
            ) : null}
            {select(
              "type",
              t("members.type"),
              MEMBERSHIP_TYPES.map((v) => ({
                value: v,
                label: t("members.facet", {
                  label: t(enumKey("membershipTypes", v)),
                  count: count(facets.types, v),
                }),
              })),
            )}
            {select(
              "groupId",
              t("members.group"),
              facets.groups.map((g) => ({
                value: g.groupId,
                label: t("members.facet", { label: g.name, count: g.count }),
              })),
            )}
            {full ? (
              <>
                {select(
                  "role",
                  t("members.role"),
                  CLUB_ROLES.map((r) => ({ value: r, label: t(enumKey("roles", r)) })),
                )}
                <label className="block space-y-1">
                  <span className="text-sm">{t("members.bornFrom")}</span>
                  <input
                    type="number"
                    name="bornFrom"
                    min={1900}
                    max={2100}
                    defaultValue={filter.bornFrom ?? ""}
                    className={inputClass}
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-sm">{t("members.bornTo")}</span>
                  <input
                    type="number"
                    name="bornTo"
                    min={1900}
                    max={2100}
                    defaultValue={filter.bornTo ?? ""}
                    className={inputClass}
                  />
                </label>
                {select(
                  "gender",
                  t("members.gender"),
                  GENDERS.map((g) => ({ value: g, label: t(enumKey("genders", g)) })),
                )}
                {select(
                  "missingConsent",
                  t("members.missingConsent"),
                  CONSENT_PURPOSES.map((p) => ({
                    value: p,
                    label: t(enumKey("consentPurposes", p)),
                  })),
                )}
              </>
            ) : null}
            {select("sort", t("members.sort"), [
              { value: "name", label: t("members.sortName") },
              { value: "member_number", label: t("members.sortMemberNumber") },
              ...(full ? [{ value: "joined", label: t("members.sortJoined") }] : []),
            ])}
            {select("order", t("members.order"), [
              { value: "asc", label: t("members.orderAsc") },
              { value: "desc", label: t("members.orderDesc") },
            ])}
          </div>
        </details>
        <div className="flex gap-2">
          <button type="submit" className={secondaryButtonClass}>
            {t("members.apply")}
          </button>
          <a href={`/clubs/${club.id}/members`} className={secondaryButtonClass}>
            {t("members.clear")}
          </a>
        </div>
      </form>

      <p className="text-sm text-muted" data-testid="register-total">
        {t("members.total", { count: page.totalCount })}
      </p>
      {page.items.length === 0 ? (
        <EmptyState title={t("members.empty")} headingLevel={2} />
      ) : page.nextCursor ? (
        <LazyRegisterList
          clubId={club.id}
          query={query}
          initialPage={{ items: page.items, nextCursor: page.nextCursor }}
          texts={{
            ...texts,
            label: t("nav.members"),
            loadMore: t("common.loadMore"),
            loading: t("common.loading"),
            failed: t("common.loadMoreFailed"),
          }}
        />
      ) : (
        <ul className="divide-y divide-border" data-testid="register" aria-label={t("nav.members")}>
          {page.items.map((member) => (
            <li key={member.person.id}>
              <RegisterEntry member={member} clubId={club.id} texts={texts} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
