// SPDX-License-Identifier: AGPL-3.0-only
// Who has opened a profile (P1.12): for the person and full guardians, every
// logged view in every club, newest first; viewers the reader may not see
// appear as "someone with protected identity". Keyset "Show more".
import { isUuid } from "@clubadmin/shared";
import { PersonName } from "@clubadmin/ui";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { ProfileViewList } from "../../../../../components/protection.tsx";
import { getAccessLog, getPerson } from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ personId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("protection.accessLogOf") };
}

export default async function AccessLogPage({ params, searchParams }: Props) {
  const [{ personId }, query, t] = await Promise.all([params, searchParams, getTranslations()]);
  if (!isUuid(personId)) notFound();
  const cursor = typeof query.cursor === "string" ? query.cursor : null;
  const [profile, page] = await Promise.all([
    getPerson(personId, null),
    getAccessLog(personId, cursor),
  ]);
  return (
    <div className="max-w-3xl space-y-4" data-testid="access-log-page">
      <h1 className="text-2xl font-semibold">{t("protection.accessLogOf")}</h1>
      <p>
        <PersonName person={profile.person} protectedLabel={t("protected.tooltip")} />
      </p>
      <p className="text-sm text-muted">{t("protection.accessLogIntro")}</p>
      <ProfileViewList
        items={page.items}
        emptyText={t("protection.logEmpty")}
        testId="access-log"
      />
      {page.nextCursor ? (
        <a href={`/people/${personId}/access-log?cursor=${page.nextCursor}`} className="underline">
          {t("protection.showMore")}
        </a>
      ) : null}
    </div>
  );
}
