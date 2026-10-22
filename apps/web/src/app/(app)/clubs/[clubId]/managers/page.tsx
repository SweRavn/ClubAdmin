// SPDX-License-Identifier: AGPL-3.0-only
// The club's managers (P1.1, ADR 0018): remove or step down (never the last
// one) and the open hand-over proposal. New managers and hand-overs start
// from a member's profile.
import { EmptyState, personLabel, PersonName } from "@clubadmin/ui";
import { getLocale, getTranslations } from "next-intl/server";

import { ActionForm, secondaryButtonClass } from "../../../../../components/action-form.tsx";
import { FormError } from "../../../../../components/form-error.tsx";
import {
  getClub,
  getClubManagers,
  getMe,
  getMyClubs,
  getMyHandovers,
} from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("managers.title") };
}

export default async function ManagersPage({ params, searchParams }: Props) {
  const [{ clubId }, query] = await Promise.all([params, searchParams]);
  const [t, locale, club, managers, mine, me, handovers] = await Promise.all([
    getTranslations(),
    getLocale(),
    getClub(clubId),
    getClubManagers(clubId),
    getMyClubs(),
    getMe(),
    getMyHandovers(),
  ]);
  const permissions = mine.clubs.find((c) => c.club.id === club.id)?.permissions ?? [];
  const canManage = permissions.includes("club.roles.manage");
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const outgoing = handovers.outgoing.filter((h) => h.club.id === club.id);
  const single = managers.items.length <= 1;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t("managers.title")}</h1>
      <FormError code={query.error} />
      {managers.items.length === 0 ? (
        <EmptyState title={t("club.noManagers")} headingLevel={2} />
      ) : (
        <ul
          className="divide-y divide-border rounded-lg border border-border bg-raised"
          data-testid="managers"
        >
          {managers.items.map((m) => (
            <li key={m.person.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <PersonName
                person={m.person}
                href={`/people/${m.person.id}?clubId=${club.id}`}
                protectedLabel={t("protected.tooltip")}
              />
              <span className="text-sm text-muted">
                {t("managers.since", { date: date.format(new Date(m.since)) })}
              </span>
              {canManage && !single ? (
                <ActionForm action="remove-manager" className="ml-auto">
                  <input type="hidden" name="clubId" value={club.id} />
                  <input type="hidden" name="personId" value={m.person.id} />
                  <button type="submit" className={secondaryButtonClass}>
                    {m.person.id === me.personId ? t("managers.stepDown") : t("managers.remove")}
                  </button>
                </ActionForm>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canManage && single ? (
        <p className="text-sm text-muted">{t("managers.lastManager")}</p>
      ) : null}
      {outgoing.map((h) => (
        <div
          key={h.id}
          className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-4"
          data-testid="outgoing-handover"
        >
          <span>
            {t("managers.pendingHandover", {
              name: h.to ? personLabel(h.to) : t("protected.label"),
              date: date.format(new Date(h.expiresAt)),
            })}
          </span>
          <ActionForm action="respond-handover" className="ml-auto">
            <input type="hidden" name="handoverId" value={h.id} />
            <button type="submit" name="response" value="cancel" className={secondaryButtonClass}>
              {t("managers.cancel")}
            </button>
          </ActionForm>
        </div>
      ))}
    </div>
  );
}
