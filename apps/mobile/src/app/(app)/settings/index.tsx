// SPDX-License-Identifier: AGPL-3.0-only
// Settings: language, time zone and theme (saved to the account, so the web
// app follows), biometric unlock, sessions, about, log out. Language and
// time zone are only offered by servers that have preferences (ADR 0029).

import { SUPPORTED_LOCALES } from "@clubadmin/i18n";
import { THEMES } from "@clubadmin/shared";
import * as LocalAuthentication from "expo-local-authentication";
import { router } from "expo-router";
import { useState } from "react";
import { Switch, TextInput, View } from "react-native";
import { useTranslations } from "use-intl";

import { useClientInfo, useMe, useUpdatePreferences } from "../../../api/queries.ts";
import { appSettings } from "../../../cache/settings.ts";
import { Body, Button, Muted, Row, Screen, Section } from "../../../components/ui.tsx";
import { hasFeature } from "../../../state/client-info.ts";
import { useSession } from "../../../state/session.tsx";
import { useTheme } from "../../../theme.ts";

/** IANA zone names as Intl accepts them. */
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export default function Settings() {
  const t = useTranslations();
  const theme = useTheme();
  const { signOut } = useSession();
  const me = useMe();
  const info = useClientInfo();
  const update = useUpdatePreferences();
  const preferences = me.data?.preferences;
  const [zone, setZone] = useState(preferences?.timeZone ?? "");
  const [zoneError, setZoneError] = useState(false);
  const [biometric, setBiometric] = useState(appSettings.biometricUnlock());
  const [leaving, setLeaving] = useState(false);

  const choose = <T extends string>(
    title: string,
    options: readonly (T | null)[],
    current: T | null | undefined,
    label: (value: T | null) => string,
    onChoose: (value: T | null) => void,
    testPrefix: string,
  ) => (
    <Section title={title}>
      {options.map((value, index) => (
        <Row
          key={value ?? "auto"}
          onPress={() => onChoose(value)}
          accessibilityLabel={label(value)}
          last={index === options.length - 1}
          testID={`${testPrefix}-${value ?? "auto"}`}
        >
          <Body style={{ fontWeight: (current ?? null) === value ? "700" : "400" }}>
            {label(value)}
            {(current ?? null) === value ? ` · ${t("mobile.selected")}` : ""}
          </Body>
        </Row>
      ))}
    </Section>
  );

  return (
    <Screen testID="settings-screen">
      {hasFeature(info.data, "me.preferences") && preferences ? (
        <>
          {choose(
            t("preferences.language"),
            [null, ...SUPPORTED_LOCALES],
            preferences.locale,
            (value) => (value ? t(`locales.${value}`) : t("preferences.automatic")),
            (locale) => update.mutate({ locale }),
            "locale",
          )}
          <Section title={t("preferences.timeZone")}>
            <View style={{ paddingVertical: theme.space(2), gap: theme.space(2) }}>
              <Muted>{t("preferences.timeZoneHint")}</Muted>
              <TextInput
                value={zone}
                onChangeText={(text) => {
                  setZone(text);
                  setZoneError(false);
                }}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel={t("preferences.timeZone")}
                style={{
                  color: theme.colors.fg,
                  borderColor: zoneError ? theme.colors.danger : theme.colors.border,
                  borderWidth: 1,
                  borderRadius: 6,
                  minHeight: theme.touch,
                  paddingHorizontal: theme.space(3),
                }}
                testID="timezone-input"
              />
              {zoneError ? (
                <Body style={{ color: theme.colors.danger }}>
                  {t("preferences.invalidTimeZone")}
                </Body>
              ) : null}
              <Button
                label={t("common.save")}
                kind="secondary"
                busy={update.isPending}
                onPress={() => {
                  const value = zone.trim();
                  if (value && !isTimeZone(value)) {
                    setZoneError(true);
                    return;
                  }
                  update.mutate({ timeZone: value || null });
                }}
              />
            </View>
          </Section>
          {choose(
            t("mobile.theme"),
            THEMES,
            preferences.theme,
            (value) => t(`mobile.themes.${value ?? "system"}`),
            (value) => update.mutate({ theme: value }),
            "theme",
          )}
        </>
      ) : null}

      <Section title={t("mobile.security")}>
        <Row>
          <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space(3) }}>
            <Body style={{ flex: 1 }}>{t("mobile.biometricUnlock")}</Body>
            <Switch
              value={biometric}
              accessibilityLabel={t("mobile.biometricUnlock")}
              onValueChange={(on) => {
                void (async () => {
                  if (on && !(await LocalAuthentication.hasHardwareAsync())) return;
                  appSettings.setBiometricUnlock(on);
                  setBiometric(on);
                })();
              }}
            />
          </View>
        </Row>
        <Row onPress={() => router.push("/settings/sessions")} testID="open-sessions">
          <Body>{t("userMenu.sessions")}</Body>
        </Row>
        <Row onPress={() => router.push("/settings/about")} last testID="open-about">
          <Body>{t("mobile.about")}</Body>
        </Row>
      </Section>

      <Button
        label={t("userMenu.logout")}
        kind="danger"
        busy={leaving}
        onPress={() => {
          setLeaving(true);
          void signOut().finally(() => {
            setLeaving(false);
            router.replace("/login");
          });
        }}
        testID="logout"
      />
    </Screen>
  );
}
