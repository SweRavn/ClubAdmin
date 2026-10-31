// SPDX-License-Identifier: AGPL-3.0-only
// The inbox (P1.7): my notifications, newest first. Tapping one marks it
// read and opens what it is about; "Mark all as read" marks everything up
// to the newest. Texts come rendered from the API; the people a notice is
// about come through the API's presenter.

import { personLabel } from "@clubadmin/shared";
import { router, Stack } from "expo-router";
import { View } from "react-native";
import { useTranslations } from "use-intl";

import { useMarkNotificationsRead, useNotifications } from "../../../api/queries.ts";
import { DateTime } from "../../../components/date-time.tsx";
import { ErrorView } from "../../../components/error-view.tsx";
import {
  Body,
  EmptyState,
  LinkButton,
  Loading,
  Muted,
  Row,
  Screen,
  Section,
} from "../../../components/ui.tsx";
import { appRoute } from "../../../state/push.ts";
import { useTheme } from "../../../theme.ts";

export default function Notifications() {
  const t = useTranslations();
  const theme = useTheme();
  const list = useNotifications();
  const mark = useMarkNotificationsRead();
  if (!list.data) {
    if (list.isError)
      return (
        <Screen>
          <ErrorView error={list.error} onRetry={() => void list.refetch()} />
        </Screen>
      );
    return <Loading label={t("common.loading")} />;
  }
  const items = list.data.pages.flatMap((p) => p.items);
  const newest = items[0];
  return (
    <Screen
      refreshing={list.isRefetching}
      onRefresh={() => void list.refetch()}
      testID="notifications-screen"
    >
      <Stack.Screen
        options={{
          headerRight: () => (
            <LinkButton
              label={t("notifications.settingsLink")}
              onPress={() => router.push("/notifications/settings")}
              testID="open-notification-settings"
            />
          ),
        }}
      />
      {newest && items.some((n) => n.readAt === null) ? (
        <LinkButton
          label={t("notifications.markAll")}
          onPress={() => mark.mutate({ before: newest.id })}
          testID="notifications-mark-all"
        />
      ) : null}
      <Section title={t("notifications.title")}>
        {items.length === 0 ? (
          <EmptyState title={t("notifications.empty")} />
        ) : (
          items.map((n, index) => {
            const unread = n.readAt === null;
            return (
              <Row
                key={n.id}
                last={index === items.length - 1}
                testID={`notification-${n.id}`}
                accessibilityLabel={`${unread ? `${t("notifications.unreadMark")} ` : ""}${n.title}`}
                onPress={() => {
                  if (unread) mark.mutate({ ids: [n.id] });
                  router.push(appRoute(n.link));
                }}
              >
                <View style={{ flexDirection: "row", gap: theme.space(2), alignItems: "center" }}>
                  <View
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 4,
                      backgroundColor: unread ? theme.colors.accent : "transparent",
                    }}
                  />
                  <Body style={{ flex: 1, fontWeight: unread ? "700" : "400" }}>{n.title}</Body>
                </View>
                {n.body ? <Body>{n.body}</Body> : null}
                <Muted>
                  {[n.about.map((p) => personLabel(p)).join(", "), n.club?.name ?? ""]
                    .filter(Boolean)
                    .join(" · ")}
                </Muted>
                <DateTime value={n.createdAt} style={{ fontSize: 13 }} />
              </Row>
            );
          })
        )}
      </Section>
      {list.hasNextPage ? (
        <LinkButton
          label={t("notifications.older")}
          onPress={() => void list.fetchNextPage()}
          testID="notifications-more"
        />
      ) : null}
    </Screen>
  );
}
