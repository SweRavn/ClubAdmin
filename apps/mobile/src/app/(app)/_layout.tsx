// SPDX-License-Identifier: AGPL-3.0-only
// Signed-in part of the app: redirects to login when there is no login, shows
// the banners and the screens.

import { Redirect, Stack } from "expo-router";
import { View } from "react-native";
import { useTranslations } from "use-intl";

import { useClientInfo } from "../../api/queries.ts";
import { Banners } from "../../components/banners.tsx";
import { hasFeature } from "../../state/client-info.ts";
import { usePush } from "../../state/push.ts";
import { useSession } from "../../state/session.tsx";
import { useTheme } from "../../theme.ts";

export default function SignedInLayout() {
  const { status, api, personId } = useSession();
  const theme = useTheme();
  const t = useTranslations();
  const info = useClientInfo();
  // Push only when the server has a push provider (P1.7, ADR 0029).
  usePush(
    api,
    status === "signedIn" ? personId : null,
    hasFeature(info.data, "notifications.push"),
  );
  if (status === "signedOut") return <Redirect href="/login" />;
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.colors.surface },
          headerTintColor: theme.colors.fg,
          contentStyle: { backgroundColor: theme.colors.bg },
          headerBackButtonDisplayMode: "minimal",
        }}
        screenLayout={({ children }) => (
          <View style={{ flex: 1 }}>
            <Banners />
            {children}
          </View>
        )}
      >
        <Stack.Screen name="schedule" options={{ title: t("schedule.title") }} />
        <Stack.Screen
          name="activities/[activityId]"
          options={{ title: t("activities.calendar") }}
        />
        <Stack.Screen name="attendance/[activityId]" options={{ title: t("attendance.title") }} />
        <Stack.Screen name="events/index" options={{ title: t("events.title") }} />
        <Stack.Screen name="events/[eventId]" options={{ title: t("events.title") }} />
        <Stack.Screen name="home" options={{ title: t("home.title") }} />
        <Stack.Screen name="clubs/[clubId]/index" options={{ title: t("club.overview") }} />
        <Stack.Screen name="clubs/[clubId]/groups" options={{ title: t("club.groups") }} />
        <Stack.Screen name="groups/[groupId]" options={{ title: t("nav.groups") }} />
        <Stack.Screen name="people/[personId]" options={{ title: t("person.title") }} />
        <Stack.Screen name="settings/index" options={{ title: t("mobile.settings") }} />
        <Stack.Screen name="settings/sessions" options={{ title: t("sessions.title") }} />
        <Stack.Screen name="settings/family" options={{ title: t("family.title") }} />
        <Stack.Screen name="settings/about" options={{ title: t("mobile.about") }} />
        <Stack.Screen name="notifications/index" options={{ title: t("notifications.title") }} />
        <Stack.Screen
          name="notifications/settings"
          options={{ title: t("notifications.settings.title") }}
        />
      </Stack>
    </View>
  );
}
