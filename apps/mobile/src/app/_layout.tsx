// SPDX-License-Identifier: AGPL-3.0-only
// Root of the app: login and cache (SessionProvider), the current club,
// language and time zone (same chain as the web), theme, and the gates for a
// required update and biometric unlock.

import "../i18n/types.ts";

import { getCalendars, getLocales } from "expo-localization";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useTranslations } from "use-intl";

import { useMe } from "../api/queries.ts";
import { BiometricGate, UpdateGate } from "../components/gates.tsx";
import { acceptLanguage, resolveLocale, resolveTimeZone } from "../i18n/locale.ts";
import { I18nProvider } from "../i18n/provider.tsx";
import { ClubProvider, useCurrentClub } from "../state/club.tsx";
import { SessionProvider, useSession } from "../state/session.tsx";
import { ThemeProvider, useTheme } from "../theme.ts";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <ClubProvider>
          <LocaleLayer />
        </ClubProvider>
      </SessionProvider>
    </SafeAreaProvider>
  );
}

function LocaleLayer() {
  const { status, setAcceptLanguage } = useSession();
  const me = useMe();
  const { club } = useCurrentClub();
  const signedIn = status === "signedIn";
  const preferences = signedIn ? me.data?.preferences : undefined;
  const locale = resolveLocale({
    preference: preferences?.locale,
    clubLocale: signedIn ? club?.club.defaultLocale : null,
    deviceLocales: getLocales().map((l) => l.languageTag),
  });
  const timeZone = resolveTimeZone({
    preference: preferences?.timeZone,
    clubTimeZone: signedIn ? club?.club.timeZone : null,
    deviceTimeZone: getCalendars()[0]?.timeZone,
  });
  useEffect(() => setAcceptLanguage(acceptLanguage(locale)), [locale, setAcceptLanguage]);
  return (
    <ThemeProvider preference={preferences?.theme}>
      <I18nProvider locale={locale} timeZone={timeZone}>
        <UpdateGate>
          <BiometricGate>
            <AppStack />
          </BiometricGate>
        </UpdateGate>
      </I18nProvider>
    </ThemeProvider>
  );
}

function AppStack() {
  const theme = useTheme();
  const t = useTranslations();
  return (
    <>
      <StatusBar style={theme.dark ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.colors.surface },
          headerTintColor: theme.colors.fg,
          contentStyle: { backgroundColor: theme.colors.bg },
          headerBackButtonDisplayMode: "minimal",
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="login" options={{ title: t("login.title"), headerShown: false }} />
        <Stack.Screen name="(app)" options={{ headerShown: false }} />
        <Stack.Screen name="+not-found" options={{ title: t("errors.notFound.title") }} />
      </Stack>
    </>
  );
}
