// SPDX-License-Identifier: AGPL-3.0-only
// An announcement in the app (P2.3): its text (the shared Markdown), from
// whom and when. Opening it marks it read (and its notice). Its sender (and
// those who manage it) change or withdraw it here (P2.7g); drafts,
// scheduling and the statistics stay on the web.
import { router, Stack } from "expo-router";
import { useEffect } from "react";
import { View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import {
  useAnnouncement,
  useMarkAnnouncementRead,
  useWithdrawAnnouncement,
} from "../../../../api/queries.ts";
import { DataAge } from "../../../../components/data-age.tsx";
import { ErrorView } from "../../../../components/error-view.tsx";
import { FormError, formErrorsOf, useOnline } from "../../../../components/form.tsx";
import { Markdown } from "../../../../components/markdown.tsx";
import { PersonName } from "../../../../components/person-name.tsx";
import { useIdParam } from "../../../../components/route-id.ts";
import { Body, Button, Loading, Muted, Screen } from "../../../../components/ui.tsx";
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
  const withdraw = useWithdrawAnnouncement(clubId, announcementId);
  const online = useOnline();
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
      {a.canManage && a.status !== "withdrawn" ? (
        <View style={{ gap: theme.space(2) }}>
          {a.status !== "sent" ? <Muted>{t(`announcements.statuses.${a.status}`)}</Muted> : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space(2) }}>
            <Button
              kind="secondary"
              label={t("announcements.edit")}
              disabled={!online}
              onPress={() =>
                router.push(`/announcements/new?clubId=${clubId}&announcementId=${announcementId}`)
              }
              testID="announcement-edit"
            />
            {a.status === "sent" ? (
              <Button
                kind="danger"
                label={t("announcements.withdraw")}
                disabled={!online}
                busy={withdraw.isPending}
                onPress={() => withdraw.mutate()}
                testID="announcement-withdraw"
              />
            ) : null}
          </View>
          <FormError errors={formErrorsOf(withdraw.error)} />
        </View>
      ) : a.status === "withdrawn" ? (
        <Muted testID="announcement-withdrawn">{t("announcements.statuses.withdrawn")}</Muted>
      ) : null}
    </Screen>
  );
}
