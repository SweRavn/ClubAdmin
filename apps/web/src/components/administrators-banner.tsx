// SPDX-License-Identifier: AGPL-3.0-only
// The club's administrator state (P1.15 A3, ADR 0046) for its administrators:
// no new members with fewer than two (or the grace period's end), and the
// recommendation of a third (hidden for 90 days on this device).
import type { AdministratorsOverview } from "@clubadmin/shared";
import { getLocale, getTranslations } from "next-intl/server";

import { DismissibleHint } from "./dismissible-hint.tsx";

export async function AdministratorsBanner({
  clubId,
  overview,
}: {
  clubId: string;
  overview: AdministratorsOverview;
}) {
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const link = (
    <a href={`/clubs/${clubId}/administrators`} className="font-medium underline">
      {t("administrators.appointLink")}
    </a>
  );
  if (overview.state === "needs_administrators") {
    return (
      <div
        role="alert"
        className="space-y-1 rounded-md border-2 border-danger bg-surface p-3"
        data-testid="administrators-needed"
      >
        <p className="font-medium">{t("administrators.neededTitle")}</p>
        <p className="text-sm">{t("administrators.neededBody")}</p>
        {link}
      </div>
    );
  }
  if (overview.state === "grace" && overview.graceUntil) {
    const date = new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(
      new Date(overview.graceUntil),
    );
    return (
      <div
        className="space-y-1 rounded-md bg-notice p-3 text-notice-fg"
        data-testid="administrators-grace"
      >
        <p className="font-medium">{t("administrators.graceTitle", { date })}</p>
        <p className="text-sm">{t("administrators.graceBody")}</p>
        {link}
      </div>
    );
  }
  if (overview.state === "recommend_third") {
    return (
      <DismissibleHint
        storageKey={`administrators-third:${clubId}`}
        hideLabel={t("administrators.hideFor90Days")}
        days={90}
        tone="info"
        testId="administrators-recommend-third"
      >
        <p className="text-sm">{t("administrators.recommendThird")}</p>
      </DismissibleHint>
    );
  }
  return null;
}
