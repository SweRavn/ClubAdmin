// SPDX-License-Identifier: AGPL-3.0-only
// "Anslagstavlan" (P2.3, ADR 0053): the announcements of the viewer's (and
// their children's) clubs and groups, pinned ones on top, unread marked.
import { getTranslations } from "next-intl/server";

import { AnnouncementBoardView } from "../../../../components/announcements.tsx";
import { getMyAnnouncements } from "../../../../server/data.ts";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata() {
  return { title: (await getTranslations())("announcements.board") };
}

export default async function MyAnnouncementsPage({ searchParams }: Props) {
  const query = await searchParams;
  const cursor = typeof query.cursor === "string" ? query.cursor : null;
  const [t, board] = await Promise.all([getTranslations(), getMyAnnouncements(cursor)]);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("announcements.board")}</h1>
        <p className="mt-1 max-w-prose text-sm text-muted">{t("announcements.boardIntro")}</p>
      </div>
      <AnnouncementBoardView
        board={board}
        moreHref={board.nextCursor ? `/me/announcements?cursor=${board.nextCursor}` : null}
        emptyText={t("announcements.empty")}
      />
    </div>
  );
}
