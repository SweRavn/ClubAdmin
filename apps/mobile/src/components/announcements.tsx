// SPDX-License-Identifier: AGPL-3.0-only
// An announcement in a list (P2.3): title, pinned/important, from whom and
// when, a plain preview; unread ones are marked. Opens the announcement.
import { markdownToPlain } from "@clubadmin/shared";
import { router } from "expo-router";
import { Text, View } from "react-native";
import { useFormatter, useTranslations } from "use-intl";

import { useTheme } from "../theme.ts";
import { Muted, Row } from "./ui.tsx";

/** What a row shows of an announcement (the API's Announcement has more). */
type RowAnnouncement = {
  id: string;
  clubId: string;
  clubName: string;
  groupName: string | null;
  title: string;
  body: string;
  status: string;
  read: boolean;
  pinned: boolean;
  important: boolean;
  sentAt: string | null;
};

export function AnnouncementRow({
  announcement: a,
  last,
}: {
  announcement: RowAnnouncement;
  last?: boolean;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const theme = useTheme();
  const unread = a.status === "sent" && !a.read;
  const plain = markdownToPlain(a.body);
  const details = [
    a.groupName ?? a.clubName,
    a.sentAt ? format.dateTime(new Date(a.sentAt), { dateStyle: "medium" }) : null,
    a.pinned ? t("announcements.pinned") : null,
    a.important ? t("announcements.important") : null,
  ].filter(Boolean);
  return (
    <Row
      onPress={() => router.push(`/announcements/${a.clubId}/${a.id}`)}
      accessibilityLabel={unread ? `${t("announcements.unread")}: ${a.title}` : a.title}
      last={last ?? false}
      testID={`announcement-${a.id}`}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space(2) }}>
        {unread ? (
          <View
            testID="announcement-unread"
            style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.accent }}
          />
        ) : null}
        <Text style={{ color: theme.colors.fg, fontWeight: unread ? "700" : "600", flexShrink: 1 }}>
          {a.title}
        </Text>
      </View>
      <Muted>{details.join(" · ")}</Muted>
      <Muted>{plain.length > 120 ? `${plain.slice(0, 117)}…` : plain}</Muted>
    </Row>
  );
}
