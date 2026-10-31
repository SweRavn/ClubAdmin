// SPDX-License-Identifier: AGPL-3.0-only
// Notification settings in the app (P1.7): per category, email (always,
// only without the app, never) and push; quiet hours; whether push shows
// its text on the lock screen. The same settings as on the web.

import { EMAIL_MODES } from "@clubadmin/shared";
import * as Notifications from "expo-notifications";
import { useEffect, useState } from "react";
import { Linking, Switch, View } from "react-native";
import { useTranslations } from "use-intl";

import {
  type NotificationSettings,
  useNotificationSettings,
  useUpdateNotificationSettings,
} from "../../../api/queries.ts";
import { ErrorView } from "../../../components/error-view.tsx";
import { Body, LinkButton, Loading, Muted, Row, Screen, Section } from "../../../components/ui.tsx";
import { useTheme } from "../../../theme.ts";

/** The settings as the update sends them. */
const toUpdate = (s: NotificationSettings) => ({
  categories: s.categories.map(({ category, email, push }) => ({ category, email, push })),
  quietHours: s.quietHours,
  pushPreview: s.pushPreview,
});

export default function NotificationSettingsScreen() {
  const t = useTranslations();
  const theme = useTheme();
  const settings = useNotificationSettings();
  const update = useUpdateNotificationSettings();
  const [permission, setPermission] = useState<string | null>(null);
  useEffect(() => {
    void Notifications.getPermissionsAsync()
      .then((p) => setPermission(p.status))
      .catch(() => setPermission(null));
  }, []);
  if (!settings.data) {
    if (settings.isError)
      return (
        <Screen>
          <ErrorView error={settings.error} onRetry={() => void settings.refetch()} />
        </Screen>
      );
    return <Loading label={t("common.loading")} />;
  }
  const s = settings.data;
  const save = (next: ReturnType<typeof toUpdate>) => update.mutate(next);
  const push = s.channels.includes("push");
  const switchRow = (
    label: string,
    value: boolean,
    onChange: (on: boolean) => void,
    id: string,
  ) => (
    <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space(3) }}>
      <Body style={{ flex: 1 }}>{label}</Body>
      <Switch value={value} accessibilityLabel={label} onValueChange={onChange} testID={id} />
    </View>
  );
  return (
    <Screen testID="notification-settings-screen">
      <Muted>{t("notifications.settings.intro")}</Muted>
      {push && permission === "denied" ? (
        <Row onPress={() => void Linking.openSettings()}>
          <Body>{t("notifications.settings.pushDenied")}</Body>
        </Row>
      ) : null}
      {update.isError ? (
        <Body style={{ color: theme.colors.danger }}>{t("preferences.errors.failed")}</Body>
      ) : null}
      {s.categories.map((c) => {
        const name = t(`notifyCategories.${c.category}`);
        return (
          <Section key={c.category} title={name}>
            {c.emailMandatory ? <Muted>{t("notifications.settings.mandatory")}</Muted> : null}
            <Row>
              <Muted>{t("notifications.settings.email")}</Muted>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space(2) }}>
                {EMAIL_MODES.map((mode) => (
                  <LinkButton
                    key={mode}
                    label={`${t(`notifications.emailModes.${mode}`)}${c.email === mode ? ` · ${t("mobile.selected")}` : ""}`}
                    onPress={() => {
                      const next = toUpdate(s);
                      next.categories = next.categories.map((x) =>
                        x.category === c.category ? { ...x, email: mode } : x,
                      );
                      save(next);
                    }}
                    testID={`email-${c.category}-${mode}`}
                  />
                ))}
              </View>
            </Row>
            {push ? (
              <Row last>
                {switchRow(
                  t("notifications.settings.pushFor", { category: name }),
                  c.push,
                  (on) => {
                    const next = toUpdate(s);
                    next.categories = next.categories.map((x) =>
                      x.category === c.category ? { ...x, push: on } : x,
                    );
                    save(next);
                  },
                  `push-${c.category}`,
                )}
              </Row>
            ) : null}
          </Section>
        );
      })}
      {push ? (
        <Section title={t("notifications.settings.quietHours")}>
          <Row>
            {switchRow(
              t("notifications.settings.quietOn"),
              s.quietHours !== null,
              (on) =>
                save({ ...toUpdate(s), quietHours: on ? { from: "21:00", to: "07:00" } : null }),
              "quiet-hours",
            )}
            <Muted>
              {s.quietHours
                ? `${s.quietHours.from}–${s.quietHours.to}. ${t("notifications.settings.quietHint")}`
                : t("notifications.settings.quietHint")}
            </Muted>
          </Row>
          <Row last>
            {switchRow(
              t("notifications.settings.pushPreview"),
              s.pushPreview,
              (on) => save({ ...toUpdate(s), pushPreview: on }),
              "push-preview",
            )}
          </Row>
        </Section>
      ) : null}
      <Muted>{t("notifications.settings.digestHint")}</Muted>
    </Screen>
  );
}
