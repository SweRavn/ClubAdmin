// SPDX-License-Identifier: AGPL-3.0-only
// The club's pending join requests (club managers and registrars, P1.1).
import { EmptyState, personLabel, PersonName } from "@clubadmin/ui";
import { forbidden } from "next/navigation";
import { getTranslations } from "next-intl/server";

import {
  ActionForm,
  buttonClass,
  inputClass,
  secondaryButtonClass,
} from "../../../../../components/action-form.tsx";
import { FormError, Notice } from "../../../../../components/form-error.tsx";
import { getClub, getClubJoinRequests, getMyClubs } from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("joinRequests.title") };
}

export default async function JoinRequestsPage({ params, searchParams }: Props) {
  const [{ clubId }, query] = await Promise.all([params, searchParams]);
  const [t, club, mine] = await Promise.all([getTranslations(), getClub(clubId), getMyClubs()]);
  const permissions = mine.clubs.find((c) => c.club.id === club.id)?.permissions ?? [];
  if (!permissions.includes("club.join_requests.manage")) forbidden();
  const requests = await getClubJoinRequests(club.id);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t("joinRequests.title")}</h1>
      {query.decided ? <Notice>{t("joinRequests.decided")}</Notice> : null}
      <FormError code={query.error} />
      {requests.items.length === 0 ? (
        <EmptyState title={t("joinRequests.empty")} headingLevel={2} />
      ) : (
        <ul className="space-y-3" data-testid="join-requests">
          {requests.items.map((r) => (
            <li key={r.id} className="space-y-2 rounded-lg border border-border bg-raised p-4">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-semibold">
                  <PersonName person={r.person} protectedLabel={t("protected.tooltip")} />
                </span>
                {r.requestedBy ? (
                  <span className="text-sm text-muted">
                    {t("joinRequests.requestedBy", { name: personLabel(r.requestedBy) })}
                  </span>
                ) : null}
              </div>
              {r.preferredGroups.length > 0 ? (
                <p className="text-sm">
                  {t("joinRequests.preferred", {
                    groups: r.preferredGroups.map((g) => g.name).join(", "),
                  })}
                </p>
              ) : null}
              {r.message ? (
                <blockquote className="border-l-2 border-border pl-3 text-sm">
                  {r.message}
                </blockquote>
              ) : null}
              <ActionForm action="decide-join-request" className="space-y-2">
                <input type="hidden" name="clubId" value={club.id} />
                <input type="hidden" name="joinRequestId" value={r.id} />
                <label className="block space-y-1">
                  <span className="text-sm">{t("joinRequests.decisionMessage")}</span>
                  <input name="message" maxLength={1000} className={inputClass} />
                </label>
                <div className="flex gap-2">
                  <button
                    type="submit"
                    name="decision"
                    value="approve"
                    className={buttonClass}
                    data-testid={`approve-${r.person.id}`}
                  >
                    {t("joinRequests.approve")}
                  </button>
                  <button
                    type="submit"
                    name="decision"
                    value="reject"
                    className={secondaryButtonClass}
                  >
                    {t("joinRequests.reject")}
                  </button>
                </div>
              </ActionForm>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
