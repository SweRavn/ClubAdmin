// SPDX-License-Identifier: AGPL-3.0-only
// Settings: language, time zone (a searchable list with "The club's time
// zone" first, P1.6b) and theme (saved to the account, so the web app follows), biometric unlock, sessions, about, log out. Language and
// time zone are only offered by servers that have preferences (ADR 0029).

import { SUPPORTED_LOCALES } from "@clubadmin/i18n";
import { THEMES } from "@clubadmin/shared";
import * as LocalAuthentication from "expo-local-authentication";
import { router } from "expo-router";
import { useState } from "react";
import { Alert, Switch, TextInput, View } from "react-native";
import { useTranslations } from "use-intl";

import { usePendingWrites } from "../../../api/outbox.ts";
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

/** Zones offered when the engine cannot list them (Hermes without Intl.supportedValuesOf). */
const COMMON_ZONES = [
  "Europe/Stockholm",
  "Europe/Oslo",
  "Europe/Copenhagen",
  "Europe/Helsinki",
  "Europe/Berlin",
  "Europe/London",
  "Europe/Madrid",
  "Atlantic/Reykjavik",
  "UTC",
];

/** The IANA zones, or the common ones (P1.6b). */
export function timeZones(): readonly string[] {
  const intl = Intl as { supportedValuesOf?: (key: "timeZone") => string[] };
  return typeof intl.supportedValuesOf === "function"
    ? intl.supportedValuesOf("timeZone")
    : COMMON_ZONES;
}

/** Zones matching what was typed ("stock" → Europe/Stockholm), at most `limit`. */
export function matchingZones(query: string, limit = 20): string[] {
  const q = query.trim().toLowerCase().replaceAll(" ", "_");
  return timeZones()
    .filter((zone) => q === "" || zone.toLowerCase().includes(q))
    .slice(0, limit);
}

export default function Settings() {
  const t = useTranslations();
  const theme = useTheme();
  const { signOut } = useSession();
  const me = useMe();
  const info = useClientInfo();
  const update = useUpdatePreferences();
  const unsent = usePendingWrites().length;
  const preferences = me.data?.preferences;
  const [zoneQuery, setZoneQuery] = useState("");
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
          {/* The time zone (P1.6b): "The club's time zone" first, then the zones matching a search. */}
          <Section title={t("preferences.timeZone")}>
            <View style={{ paddingVertical: theme.space(2), gap: theme.space(2) }}>
              <Muted>{t("preferences.timeZoneHint")}</Muted>
              <TextInput
                value={zoneQuery}
                onChangeText={setZoneQuery}
                placeholder={t("mobile.searchTimeZone")}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel={t("mobile.searchTimeZone")}
                style={{
                  color: theme.colors.fg,
                  borderColor: theme.colors.border,
                  borderWidth: 1,
                  borderRadius: 6,
                  minHeight: theme.touch,
                  paddingHorizontal: theme.space(3),
                }}
                testID="timezone-input"
              />
              {update.isError ? (
                <Body style={{ color: theme.colors.danger }}>{t("preferences.errors.failed")}</Body>
              ) : null}
            </View>
            {[null, ...matchingZones(zoneQuery)].map((value, index, all) => {
              const current = (preferences.timeZone ?? null) === value;
              const label = value ?? t("preferences.clubTimeZone");
              return (
                <Row
                  key={value ?? "club"}
                  onPress={() => update.mutate({ timeZone: value })}
                  accessibilityLabel={label}
                  last={index === all.length - 1}
                  testID={`timezone-${value ?? "club"}`}
                >
                  <Body style={{ fontWeight: current ? "700" : "400" }}>
                    {label}
                    {current ? ` · ${t("mobile.selected")}` : ""}
                  </Body>
                </Row>
              );
            })}
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
        <Row onPress={() => router.push("/settings/family")} testID="open-family">
          <Body>{t("family.title")}</Body>
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
          const leave = () => {
            setLeaving(true);
            void signOut().finally(() => {
              setLeaving(false);
              router.replace("/login");
            });
          };
          // Answers or attendance taken offline would be lost with the cache.
          if (unsent === 0) return leave();
          Alert.alert(t("mobile.signOutPendingTitle"), t("mobile.signOutPendingBody"), [
            { text: t("mobile.cancel"), style: "cancel" },
            { text: t("mobile.signOutAnyway"), style: "destructive", onPress: leave },
          ]);
        }}
        testID="logout"
      />
    </Screen>
  );
}
