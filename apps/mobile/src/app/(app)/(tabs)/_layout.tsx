// SPDX-License-Identifier: AGPL-3.0-only
// The tab bar (P2.7g): Schema (the start), Chatt with the number of unread
// messages, Anslagstavla and Mer (clubs, groups, the rest of the app and
// settings). Other screens open above the tabs in the signed-in stack, so
// deep links and notifications work as before.

import { Tabs } from "expo-router";
import { useTranslations } from "use-intl";

import { useMyChats } from "../../../api/queries.ts";
import { useTheme } from "../../../theme.ts";

export default function TabsLayout() {
  const t = useTranslations();
  const theme = useTheme();
  // The chat list is cached and kept fresh by the realtime connection.
  const chats = useMyChats();
  const unread = (chats.data?.pages ?? [])
    .flatMap((page) => page.items)
    .reduce((sum, chat) => sum + chat.unreadCount, 0);
  return (
    <Tabs
      backBehavior="history"
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.surface },
        headerTintColor: theme.colors.fg,
        tabBarStyle: { backgroundColor: theme.colors.surface, borderTopColor: theme.colors.border },
        tabBarActiveTintColor: theme.colors.accent,
        tabBarInactiveTintColor: theme.colors.muted,
        tabBarLabelStyle: { fontSize: 13, fontWeight: "600" },
        tabBarIconStyle: { display: "none" },
        sceneStyle: { backgroundColor: theme.colors.bg },
      }}
    >
      <Tabs.Screen
        name="schedule"
        options={{ title: t("schedule.title"), tabBarButtonTestID: "tab-schedule" }}
      />
      <Tabs.Screen
        name="chats"
        options={{
          title: t("chat.nav"),
          tabBarButtonTestID: "tab-chats",
          ...(unread > 0 ? { tabBarBadge: unread > 99 ? "99+" : unread } : {}),
        }}
      />
      <Tabs.Screen
        name="announcements"
        options={{ title: t("announcements.board"), tabBarButtonTestID: "tab-board" }}
      />
      <Tabs.Screen
        name="home"
        options={{ title: t("mobile.more"), tabBarButtonTestID: "tab-more" }}
      />
    </Tabs>
  );
}
