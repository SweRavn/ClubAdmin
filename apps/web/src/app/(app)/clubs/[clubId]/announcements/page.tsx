// SPDX-License-Identifier: AGPL-3.0-only
// The club's announcements for those who send them (P2.3): every draft,
// scheduled, sent and withdrawn one, newest first, and writing a new one.
import { getTranslations } from "next-intl/server";

import { buttonClass } from "../../../../../components/action-form.tsx";
import { AnnouncementRow } from "../../../../../components/announcements.tsx";
import { FormError, Notice } from "../../../../../components/form-error.tsx";
import { getAnnouncementArchive, getClub } from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("announcements.archive") };
}

export default async function ClubAnnouncementsPage({ params, searchParams }: Props) {
  const [{ clubId }, query] = await Promise.all([params, searchParams]);
  const cursor = typeof query.cursor === "string" ? query.cursor : null;
  const [t, club, archive] = await Promise.all([
    getTranslations(),
    getClub(clubId),
    getAnnouncementArchive(clubId, null, cursor),
  ]);
  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted">
          <a href={`/clubs/${club.id}`} className="underline">
            {club.name}
          </a>
        </p>
        <h1 className="text-2xl font-semibold">{t("announcements.archive")}</h1>
        <p className="mt-1 max-w-prose text-sm text-muted">{t("announcements.archiveIntro")}</p>
      </div>
      <FormError code={query.error} />
      {query.deleted ? <Notice>{t("announcements.deleted")}</Notice> : null}
      <a
        href={`/clubs/${club.id}/announcements/new`}
        className={buttonClass}
        data-testid="new-announcement"
      >
        {t("announcements.new")}
      </a>
      {archive.items.length > 0 ? (
        <ul className="divide-y divide-border" data-testid="announcement-archive">
          {archive.items.map((a) => (
            <AnnouncementRow key={a.id} announcement={a} showStatus />
          ))}
        </ul>
      ) : (
        <p className="text-muted">{t("announcements.archiveEmpty")}</p>
      )}
      {archive.nextCursor ? (
        <a
          href={`/clubs/${club.id}/announcements?cursor=${archive.nextCursor}`}
          className="text-sm underline"
        >
          {t("announcements.more")}
        </a>
      ) : null}
    </div>
  );
}
