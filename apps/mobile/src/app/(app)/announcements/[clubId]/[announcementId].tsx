// SPDX-License-Identifier: AGPL-3.0-only
// An announcement in the app (P2.3): its text (the shared Markdown), from
// whom and when. Opening it marks it read (and its notice). Writing and
// managing announcements happen on the web.
import { Stack } from "expo-router";
import { useEffect } from "react";
import { View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import { useAnnouncement, useMarkAnnouncementRead } from "../../../../api/queries.ts";
import { DataAge } from "../../../../components/data-age.tsx";
import { ErrorView } from "../../../../components/error-view.tsx";
import { Markdown } from "../../../../components/markdown.tsx";
import { PersonName } from "../../../../components/person-name.tsx";
import { useIdParam } from "../../../../components/route-id.ts";
import { Body, Loading, Muted, Screen } from "../../../../components/ui.tsx";
import { useTheme } from "../../../../theme.ts";
import NotFound from "../../../+not-found.tsx";

export default function AnnouncementScreen() {
  const clubId = useIdParam("clubId");
  const announcementId = useIdParam("announcementId");
  if (!clubId || !announcementId) return <NotFound />;
  return <AnnouncementView clubId={clubId} announcementId={announcementId} />;
}

function AnnouncementView({ clubId, announcementId }: { clubId: string; announcementId: string }) {
  const t = useTranslations();
  const format = useFormatter();
  const theme = useTheme();
  const detail = useAnnouncement(clubId, announcementId);
  const { mutate } = useMarkAnnouncementRead();
  const unread = detail.data?.announcement.status === "sent" && !detail.data.announcement.read;
  useEffect(() => {
    if (unread) mutate({ clubId, announcementId });
  }, [unread, clubId, announcementId, mutate]);
  if (!detail.data) {
    if (detail.isError)
      return (
        <Screen>
          <ErrorView error={detail.error} onRetry={() => void detail.refetch()} />
        </Screen>
      );
    return <Loading label={t("common.loading")} />;
  }
  const a = detail.data.announcement;
  const meta = [
    a.groupName ?? a.clubName,
    a.sentAt
      ? format.dateTime(new Date(a.sentAt), { dateStyle: "medium", timeStyle: "short" })
      : null,
    a.editedAt ? t("announcements.edited") : null,
    a.important ? t("announcements.important") : null,
  ].filter(Boolean);
  return (
    <Screen
      refreshing={detail.isRefetching}
      onRefresh={() => void detail.refetch()}
      testID="announcement-screen"
    >
      <Stack.Screen options={{ title: a.groupName ?? a.clubName }} />
      <DataAge updatedAt={detail.dataUpdatedAt} />
      <View style={{ gap: theme.space(1) }}>
        <Body style={{ fontWeight: "700", fontSize: 20 }}>{a.title}</Body>
        {a.sender ? <PersonName person={a.sender} /> : null}
        <Muted>{meta.join(" · ")}</Muted>
      </View>
      <Markdown source={a.body} testID="announcement-body" />
    </Screen>
  );
}
