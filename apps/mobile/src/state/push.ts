// SPDX-License-Identifier: AGPL-3.0-only
// Push notifications (P1.7, ADR 0039): when the server has push, the app
// asks for permission once signed in, registers this phone's Expo push token
// on the account (PUT /me/push-devices, idempotent) and removes it on logout.
// Tapping a notification opens what it is about. Notifications carry only
// IDs and a path; the text is the lock-screen text the person chose.

import type { ApiClient } from "@clubadmin/api-client";
import { useQueryClient } from "@tanstack/react-query";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { useEffect } from "react";
import { Platform } from "react-native";

import { appSettings } from "../cache/settings.ts";
import { appConfig } from "../config.ts";

Notifications.setNotificationHandler({
  handleNotification: () =>
    Promise.resolve({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
});

/** Paths of notices that the app has screens for; the others open the inbox. */
export function appRoute(link: string): string {
  const path = link.split("?")[0] ?? "";
  if (/^\/activities\/[0-9a-f-]{36}$/.test(path)) return path;
  if (/^\/events\/[0-9a-f-]{36}$/.test(path)) return path;
  if (path === "/me/family") return "/settings/family";
  return "/notifications";
}

/** The Expo project the push token belongs to (EAS builds set it). */
function projectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId;
}

export type PushPermission = "granted" | "denied" | "undetermined" | "unavailable";

/** Asks for permission (once; later calls read the answer) and registers the token. */
export async function registerForPush(api: ApiClient, personId: string): Promise<PushPermission> {
  if (!Device.isDevice || Platform.OS === "web") return "unavailable";
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "ClubAdmin",
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }
  const { PermissionStatus } = Notifications;
  let { status } = await Notifications.getPermissionsAsync();
  if (status === PermissionStatus.UNDETERMINED) {
    ({ status } = await Notifications.requestPermissionsAsync());
  }
  if (status === PermissionStatus.DENIED) return "denied";
  if (status !== PermissionStatus.GRANTED) return "undetermined";
  const id = projectId();
  const token = (await Notifications.getExpoPushTokenAsync(id ? { projectId: id } : {})).data;
  const { data } = await api.PUT("/api/v1/me/push-devices", {
    body: {
      token,
      platform: Platform.OS === "ios" ? "ios" : "android",
      appVariant: appConfig.variant,
    },
  });
  if (data) appSettings.setPushDevice(personId, data.id);
  return "granted";
}

/** Logout: this phone stops getting the person's notifications (best effort). */
export async function unregisterPush(api: ApiClient, personId: string): Promise<void> {
  const deviceId = appSettings.pushDevice(personId);
  if (!deviceId) return;
  appSettings.setPushDevice(personId, null);
  try {
    await api.DELETE("/api/v1/me/push-devices/{deviceId}", {
      params: { path: { deviceId } },
    });
  } catch {
    // Offline: the server disables the token when Expo reports it unregistered.
  }
}

/** Registers when signed in and the server has push; opens tapped notifications. */
export function usePush(api: ApiClient, personId: string | null, enabled: boolean): void {
  useEffect(() => {
    if (!personId || !enabled) return;
    void registerForPush(api, personId).catch(() => undefined);
  }, [api, personId, enabled]);

  // A notice arriving while the app is open: the inbox and the schedule are
  // refreshed now, so what it is about is current when it is opened.
  const client = useQueryClient();
  useEffect(() => {
    const subscription = Notifications.addNotificationReceivedListener(() => {
      void client.invalidateQueries({ queryKey: ["me", personId, "notifications"] });
      void client.invalidateQueries({ queryKey: ["schedule"] });
      void client.invalidateQueries({ queryKey: ["events"] });
    });
    return () => subscription.remove();
  }, [client, personId]);

  useEffect(() => {
    const open = (response: Notifications.NotificationResponse | null) => {
      const link = response?.notification.request.content.data?.link;
      if (typeof link === "string") router.push(appRoute(link));
    };
    void Notifications.getLastNotificationResponseAsync().then(open);
    const subscription = Notifications.addNotificationResponseReceivedListener(open);
    return () => subscription.remove();
  }, []);
}
