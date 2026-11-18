// SPDX-License-Identifier: AGPL-3.0-only
// "Mina utlägg" (P2.5 part B, ADR 0048): the viewer's claims across clubs
// with their decisions, and a new mileage claim from their drives in a club
// (one group at a time, at the rate the board decided).
import { enumKey } from "@clubadmin/i18n";
import { formatDateTime, personLabel, RoleBadge } from "@clubadmin/ui";
import { getLocale, getTranslations } from "next-intl/server";

import { ActionForm, buttonClass } from "../../../../components/action-form.tsx";
import { money } from "../../../../components/billing.tsx";
import { FormError, Notice } from "../../../../components/form-error.tsx";
import {
  getClaimableDrives,
  getMyClubs,
  getMyExpenseClaims,
  getMyGroups,
} from "../../../../server/data.ts";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata() {
  return { title: (await getTranslations())("expenses.mine") };
}

export default async function MyExpensesPage({ searchParams }: Props) {
  const query = await searchParams;
  const cursor = typeof query.cursor === "string" ? query.cursor : null;
  const [t, locale, page, clubs, groups] = await Promise.all([
    getTranslations(),
    getLocale(),
    getMyExpenseClaims(cursor),
    getMyClubs(),
    getMyGroups(),
  ]);
  const clubId =
    typeof query.clubId === "string" && clubs.clubs.some((c) => c.club.id === query.clubId)
      ? query.clubId
      : null;
  const claimable = clubId ? await getClaimableDrives(clubId) : null;
  const groupName = new Map(
    [...groups.groups, ...groups.wards.flatMap((w) => w.groups)].map((g) => [
      g.group.id,
      g.group.name,
    ]),
  );
  const zone = new Map(clubs.clubs.map((c) => [c.club.id, c.club.timeZone]));
  const day = (iso: string, inClub: string | null) =>
    formatDateTime(iso, { locale, timeZone: zone.get(inClub ?? "") ?? "UTC", dateStyle: "medium" });
  const byGroup = new Map<string, NonNullable<typeof claimable>["drives"]>();
  for (const d of claimable?.drives ?? []) {
    for (const g of d.groupIds) {
      if (!groupName.has(g)) continue;
      byGroup.set(g, [...(byGroup.get(g) ?? []), d]);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("expenses.mine")}</h1>
        <p className="mt-1 max-w-prose text-sm text-muted">{t("expenses.mineIntro")}</p>
      </div>
      <FormError code={query.error} />
      {query.submitted ? <Notice>{t("expenses.submitted")}</Notice> : null}

      <section aria-labelledby="new-claim" className="space-y-3">
        <h2 id="new-claim" className="text-lg font-semibold">
          {t("expenses.new")}
        </h2>
        <nav className="flex flex-wrap gap-3 text-sm">
          {clubs.clubs.map((c) => (
            <a
              key={c.club.id}
              href={`/me/expenses?clubId=${c.club.id}`}
              className={c.club.id === clubId ? "font-semibold" : "underline"}
            >
              {c.club.name}
            </a>
          ))}
        </nav>
        {clubId && !claimable ? (
          <p className="text-sm text-muted">{t("expenses.notInPlan")}</p>
        ) : null}
        {claimable && claimable.mileageRate === null ? (
          <p className="text-sm text-muted">{t("expenses.noRate")}</p>
        ) : null}
        {claimable && claimable.mileageRate !== null && byGroup.size === 0 ? (
          <p className="text-sm text-muted" data-testid="claimable-empty">
            {t("expenses.noDrives")}
          </p>
        ) : null}
        {claimable && claimable.mileageRate !== null
          ? [...byGroup].map(([groupId, drives]) => (
              <ActionForm
                key={groupId}
                action="expense-claim"
                className="space-y-2 rounded-lg border border-border p-3"
                testId="claim-form"
              >
                <input type="hidden" name="clubId" value={clubId ?? ""} />
                <input type="hidden" name="groupId" value={groupId} />
                <input type="hidden" name="back" value="/me/expenses" />
                <p className="font-medium">{groupName.get(groupId)}</p>
                <p className="text-sm text-muted">
                  {t("expenses.rate", {
                    rate: money(locale, claimable.mileageRate! * 10, claimable.currency),
                  })}
                </p>
                <ul className="space-y-1">
                  {drives.map((d) => (
                    <li key={d.offerId}>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          name="offerId"
                          value={d.offerId}
                          defaultChecked={d.distanceKm !== null}
                          disabled={d.distanceKm === null}
                        />
                        {day(d.startsAt, clubId)} · {d.activityTitle} ·{" "}
                        {t(enumKey("carpool.directions", d.direction))} ·{" "}
                        {d.distanceKm === null
                          ? t("expenses.noDistance")
                          : t("expenses.km", { km: d.distanceKm })}
                      </label>
                    </li>
                  ))}
                </ul>
                <button type="submit" className={buttonClass} data-testid="claim-submit">
                  {t("expenses.submit")}
                </button>
              </ActionForm>
            ))
          : null}
      </section>

      <section aria-labelledby="claims" className="space-y-2">
        <h2 id="claims" className="text-lg font-semibold">
          {t("expenses.claims")}
        </h2>
        {page.items.length === 0 ? (
          <p className="text-muted">{t("expenses.none")}</p>
        ) : (
          <ul className="divide-y divide-border" data-testid="my-claims">
            {page.items.map((c) => (
              <li key={c.id} className="space-y-1 py-3" data-testid="my-claim">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-medium tabular-nums">
                    {money(locale, c.amountMinor, c.currency)}
                  </span>
                  <RoleBadge
                    tone={c.status === "rejected" ? "accent" : "neutral"}
                    label={t(enumKey("expenses.statuses", c.status))}
                  />
                </p>
                <p className="text-sm text-muted">
                  {c.clubName ? `${c.clubName} · ` : ""}
                  {c.groupName} · {day(c.createdAt, c.clubId)}
                  {c.decidedBy
                    ? ` · ${t("expenses.decidedBy", { name: personLabel(c.decidedBy) })}`
                    : ""}
                </p>
                {c.reason ? <p className="text-sm">{c.reason}</p> : null}
              </li>
            ))}
          </ul>
        )}
        {page.nextCursor ? (
          <a href={`/me/expenses?cursor=${page.nextCursor}`} className="text-sm underline">
            {t("announcements.more")}
          </a>
        ) : null}
      </section>
    </div>
  );
}
