// SPDX-License-Identifier: AGPL-3.0-only
// Login: Zitadel in the system browser (PKCE), and in development builds the
// DEV_AUTH persona picker. After login the app goes to the home screen.

import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { useTranslations } from "use-intl";

import { PersonaPicker } from "../components/persona-picker.tsx";
import { Body, Button, Heading, Muted, Screen } from "../components/ui.tsx";
import { appConfig, BUILD_VARIANT, DEV_AUTH_BUILD } from "../config.ts";
import { useSession } from "../state/session.tsx";
import { useTheme } from "../theme.ts";

export default function Login() {
  const t = useTranslations();
  const theme = useTheme();
  const { signIn, signInAsPersona } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (result !== "cancelled") router.replace("/home");
    } catch (cause) {
      // Development and preview builds: the reason in logcat / the console
      // (error codes and HTTP statuses, never tokens or personal data).
      if (BUILD_VARIANT !== "production") {
        console.warn(
          `ClubAdmin: login failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
      setError(t("login.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen testID="login-screen">
      <View style={{ gap: theme.space(2), paddingTop: theme.space(10) }}>
        <Heading>{t("common.appName")}</Heading>
        <Muted>{t("common.tagline")}</Muted>
      </View>
      {appConfig.authClientId ? (
        <Button
          label={t("login.email")}
          onPress={() => void run(signIn)}
          busy={busy}
          testID="login-zitadel"
        />
      ) : (
        <Muted>{t("login.notConfigured")}</Muted>
      )}
      {error ? <Body style={{ color: theme.colors.danger }}>{error}</Body> : null}
      {DEV_AUTH_BUILD && appConfig.devAuth ? (
        <PersonaPicker onPick={(personId, mfa) => void run(() => signInAsPersona(personId, mfa))} />
      ) : null}
    </Screen>
  );
}
