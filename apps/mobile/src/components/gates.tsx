// SPDX-License-Identifier: AGPL-3.0-only
// What stands between opening the app and its content: a required update
// (below the server's minimum version, ADR 0029) and, if turned on,
// biometric unlock after the app was in the background for a while.

import * as Application from "expo-application";
import * as LocalAuthentication from "expo-local-authentication";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { AppState, Linking, Platform, View } from "react-native";
import { useTranslations } from "use-intl";

import { useClientInfo } from "../api/queries.ts";
import { appSettings } from "../cache/settings.ts";
import { APP_VERSION } from "../config.ts";
import { storeUrl, updateState } from "../state/client-info.ts";
import { useSession } from "../state/session.tsx";
import { useTheme } from "../theme.ts";
import { Body, Button, Heading, LinkButton, Muted } from "./ui.tsx";

export const appVersion = () => Application.nativeApplicationVersion ?? APP_VERSION;

/** Blocks the app below the minimum version; offers the store page if there is one. */
export function UpdateGate({ children }: { children: ReactNode }) {
  const t = useTranslations("mobile");
  const info = useClientInfo();
  const theme = useTheme();
  const state = updateState(info.data, Platform.OS, appVersion());
  if (state !== "required") return children;
  const url = storeUrl(info.data, Platform.OS);
  return (
    <View
      style={{
        flex: 1,
        justifyContent: "center",
        padding: theme.space(6),
        gap: theme.space(4),
        backgroundColor: theme.colors.bg,
      }}
      testID="update-required"
    >
      <Heading>{t("updateRequiredTitle")}</Heading>
      <Body>{t("updateRequiredBody")}</Body>
      {url ? <Button label={t("openStore")} onPress={() => void Linking.openURL(url)} /> : null}
    </View>
  );
}

/** A dismissible notice below the recommended version. */
export function UpdateNotice() {
  const t = useTranslations("mobile");
  const info = useClientInfo();
  const [dismissed, setDismissed] = useState(() => appSettings.dismissedUpdate());
  const recommended = info.data?.apps[Platform.OS === "ios" ? "ios" : "android"].recommendedVersion;
  if (updateState(info.data, Platform.OS, appVersion()) !== "recommended") return null;
  if (!recommended || dismissed === recommended) return null;
  const url = storeUrl(info.data, Platform.OS);
  return (
    <View testID="update-available">
      <Muted style={{ paddingHorizontal: 16, paddingTop: 8 }}>{t("updateAvailable")}</Muted>
      <View style={{ flexDirection: "row", gap: 16, paddingHorizontal: 16 }}>
        {url ? (
          <LinkButton label={t("openStore")} onPress={() => void Linking.openURL(url)} />
        ) : null}
        <LinkButton
          label={t("dismiss")}
          onPress={() => {
            appSettings.setDismissedUpdate(recommended);
            setDismissed(recommended);
          }}
        />
      </View>
    </View>
  );
}

/** Ask for Face ID / fingerprint after this long in the background. */
const LOCK_AFTER_MS = 5 * 60_000;

export function BiometricGate({ children }: { children: ReactNode }) {
  const t = useTranslations("mobile");
  const theme = useTheme();
  const { status } = useSession();
  const [locked, setLocked] = useState(
    () => status === "signedIn" && appSettings.biometricUnlock(),
  );
  const backgroundSince = useRef<number | null>(null);

  const unlock = useCallback(async () => {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: t("unlockPrompt"),
      cancelLabel: t("cancel"),
    });
    if (result.success) setLocked(false);
  }, [t]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "background") backgroundSince.current = Date.now();
      if (state === "active" && backgroundSince.current !== null) {
        const away = Date.now() - backgroundSince.current;
        backgroundSince.current = null;
        if (away > LOCK_AFTER_MS && appSettings.biometricUnlock()) setLocked(true);
      }
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (locked) void unlock();
  }, [locked, unlock]);

  if (!locked || status !== "signedIn") return children;
  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        gap: theme.space(4),
        backgroundColor: theme.colors.bg,
      }}
    >
      <Heading>{t("unlockPrompt")}</Heading>
      <Button label={t("unlock")} onPress={() => void unlock()} />
    </View>
  );
}
