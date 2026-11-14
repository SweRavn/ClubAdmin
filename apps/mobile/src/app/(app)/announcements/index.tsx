// SPDX-License-Identifier: AGPL-3.0-only
// "Anslagstavlan" (P2.3, ADR 0053): pinned announcements on top, then the
// newest of the person's (and their children's) clubs and groups; unread
// ones marked. Cache first: the cached board shows at once.
import { useTranslations } from "use-intl";

import { useMyAnnouncements } from "../../../api/queries.ts";
import { AnnouncementRow } from "../../../components/announcements.tsx";
import { DataAge } from "../../../components/data-age.tsx";
import { ErrorView } from "../../../components/error-view.tsx";
import { Button, EmptyState, Loading, Screen, Section } from "../../../components/ui.tsx";

export default function MyAnnouncements() {
  const t = useTranslations();
  const board = useMyAnnouncements();
  if (!board.data) {
    if (board.isError)
      return (
        <Screen>
          <ErrorView error={board.error} onRetry={() => void board.refetch()} />
        </Screen>
      );
    return <Loading label={t("common.loading")} />;
  }
  const pinned = board.data.pages[0]?.pinned ?? [];
  const items = board.data.pages.flatMap((page) => page.items);
  return (
    <Screen
      refreshing={board.isRefetching}
      onRefresh={() => void board.refetch()}
      testID="announcements-screen"
    >
      <DataAge updatedAt={board.dataUpdatedAt} />
      {pinned.length > 0 ? (
        <Section title={t("announcements.pinned")}>
          {pinned.map((a, i) => (
            <AnnouncementRow key={a.id} announcement={a} last={i === pinned.length - 1} />
          ))}
        </Section>
      ) : null}
      <Section title={t("announcements.board")}>
        {items.length === 0 && pinned.length === 0 ? (
          <EmptyState title={t("announcements.empty")} />
        ) : (
          items.map((a, i) => (
            <AnnouncementRow key={a.id} announcement={a} last={i === items.length - 1} />
          ))
        )}
      </Section>
      {board.hasNextPage ? (
        <Button
          label={t("announcements.more")}
          kind="secondary"
          busy={board.isFetchingNextPage}
          onPress={() => void board.fetchNextPage()}
          testID="announcements-more"
        />
      ) : null}
    </Screen>
  );
}
