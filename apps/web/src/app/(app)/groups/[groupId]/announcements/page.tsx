// SPDX-License-Identifier: AGPL-3.0-only
// A group's board (P2.3): its announcements the viewer reads, pinned on top;
// for those who send to the group, its drafts and scheduled ones too, and
// writing a new one.
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { buttonClass } from "../../../../../components/action-form.tsx";
import {
  AnnouncementBoardView,
  AnnouncementRow,
} from "../../../../../components/announcements.tsx";
import { FormError, Notice } from "../../../../../components/form-error.tsx";
import {
  getAnnouncementArchive,
  getGroup,
  getGroupAnnouncements,
} from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ groupId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("announcements.title") };
}

export default async function GroupAnnouncementsPage({ params, searchParams }: Props) {
  const [{ groupId }, query] = await Promise.all([params, searchParams]);
  const cursor = typeof query.cursor === "string" ? query.cursor : null;
  const [t, group] = await Promise.all([getTranslations(), getGroup(groupId)]);
  const board = await getGroupAnnouncements(group.clubId, group.id, cursor);
  if (!board) notFound();
  const sends =
    board.pinned.concat(board.items).some((a) => a.canManage) || group.canManage === true;
  const unsent = sends
    ? ((await getAnnouncementArchive(group.clubId, group.id, null).catch(() => null))?.items.filter(
        (a) => a.status === "draft" || a.status === "scheduled",
      ) ?? [])
    : [];
  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted">
          <a href={`/groups/${group.id}`} className="underline">
            {group.name}
          </a>
        </p>
        <h1 className="text-2xl font-semibold">{t("announcements.title")}</h1>
      </div>
      <FormError code={query.error} />
      {query.deleted ? <Notice>{t("announcements.deleted")}</Notice> : null}
      {sends ? (
        <a
          href={`/clubs/${group.clubId}/announcements/new?groupId=${group.id}`}
          className={buttonClass}
          data-testid="new-group-announcement"
        >
          {t("announcements.new")}
        </a>
      ) : null}
      {unsent.length > 0 ? (
        <section aria-labelledby="unsent" className="space-y-2">
          <h2 id="unsent" className="text-lg font-semibold">
            {t("announcements.unsent")}
          </h2>
          <ul className="divide-y divide-border">
            {unsent.map((a) => (
              <AnnouncementRow key={a.id} announcement={a} showStatus />
            ))}
          </ul>
        </section>
      ) : null}
      <AnnouncementBoardView
        board={board}
        moreHref={
          board.nextCursor ? `/groups/${group.id}/announcements?cursor=${board.nextCursor}` : null
        }
        emptyText={t("announcements.groupEmpty")}
      />
    </div>
  );
}
