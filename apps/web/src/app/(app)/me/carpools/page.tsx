// SPDX-License-Identifier: AGPL-3.0-only
// "Mina samåkningar" (P2.5, ADR 0048): the viewer's drives and their own
// and their children's seats across clubs, the confirmations they are asked
// for first (with the driver's name, which a notice never carries).
import { enumKey } from "@clubadmin/i18n";
import { formatDateTime, personLabel, RoleBadge } from "@clubadmin/ui";
import { getLocale, getTranslations } from "next-intl/server";

import { ActionForm, buttonClass } from "../../../../components/action-form.tsx";
import { FormError, Notice } from "../../../../components/form-error.tsx";
import { getMe, getMyCarpools, getMyClubs } from "../../../../server/data.ts";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata() {
  return { title: (await getTranslations())("carpool.mine") };
}

export default async function MyCarpoolsPage({ searchParams }: Props) {
  const query = await searchParams;
  const [t, locale, me, list, clubs] = await Promise.all([
    getTranslations(),
    getLocale(),
    getMe(),
    getMyCarpools(),
    getMyClubs(),
  ]);
  const zone = new Map(clubs.clubs.map((c) => [c.club.id, c.club.timeZone]));
  const when = (iso: string, clubId: string) =>
    formatDateTime(iso, {
      locale,
      timeZone: zone.get(clubId) ?? "UTC",
      dateStyle: "medium",
      timeStyle: "short",
    });
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("carpool.mine")}</h1>
        <p className="mt-1 max-w-prose text-sm text-muted">{t("carpool.mineIntro")}</p>
      </div>
      <FormError code={query.error} />
      {query.confirmed ? <Notice>{t("carpool.confirmed")}</Notice> : null}
      {list.items.length === 0 ? (
        <p className="text-muted" data-testid="carpools-empty">
          {t("carpool.mineEmpty")}
        </p>
      ) : (
        <ul className="divide-y divide-border" data-testid="my-carpools">
          {list.items.map((item) => {
            const asked =
              item.status === "pending_guardian" &&
              item.passenger !== null &&
              item.passenger.id !== me.person.id;
            return (
              <li
                key={`${item.offerId}:${item.bookingId ?? "driver"}`}
                className="space-y-1 py-3"
                data-testid="my-carpool"
              >
                <p className="font-medium">
                  <a href={`/activities/${item.activityId}`} className="underline">
                    {item.activityTitle}
                  </a>
                </p>
                <p className="text-sm text-muted">
                  {item.clubName} · {when(item.startsAt, item.clubId)} ·{" "}
                  {t(enumKey("carpool.directions", item.direction))}
                </p>
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  {item.driving ? (
                    <RoleBadge label={t("carpool.youDrive")} />
                  ) : (
                    <>
                      {item.passenger ? personLabel(item.passenger) : null}
                      {item.driver
                        ? ` · ${t("carpool.withDriver", { driver: personLabel(item.driver) })}`
                        : null}
                    </>
                  )}
                  {item.status === "pending_guardian" ? (
                    <RoleBadge tone="accent" label={t("carpool.pending")} />
                  ) : null}
                </p>
                {asked && item.bookingId ? (
                  <ActionForm action="carpool-confirm">
                    <input type="hidden" name="bookingId" value={item.bookingId} />
                    <input type="hidden" name="back" value="/me/carpools" />
                    <p className="max-w-prose text-sm">
                      {t("carpool.confirmText", {
                        child: item.passenger ? personLabel(item.passenger) : "",
                        driver: item.driver ? personLabel(item.driver) : "",
                      })}
                    </p>
                    <button type="submit" className={buttonClass} data-testid="my-carpool-confirm">
                      {t("carpool.confirmButton")}
                    </button>
                  </ActionForm>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-sm">
        <a href="/me/expenses" className="underline">
          {t("expenses.mine")}
        </a>
      </p>
    </div>
  );
}
