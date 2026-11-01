// SPDX-License-Identifier: AGPL-3.0-only
// Privacy in the app (P1.8a): my consents and my children's per club, with
// the club's text; each given or withdrawn with one tap (shown at once,
// rolled back if the server refuses). The club's privacy policy opens in
// the app; leaving a club, with its preview and what must be settled
// first, opens the web page. P1.8b: deleting my account (in the app);
// "download my data" opens the web page.

import { personLabel } from "@clubadmin/shared";
import { router } from "expo-router";
import { Linking, Switch, View } from "react-native";
import { useTranslations } from "use-intl";

import { useChangeConsent, useMe, useMyConsents } from "../../../api/queries.ts";
import { ErrorView } from "../../../components/error-view.tsx";
import { Body, LinkButton, Loading, Muted, Row, Screen, Section } from "../../../components/ui.tsx";
import { appConfig } from "../../../config.ts";
import { useTheme } from "../../../theme.ts";

/** The web app next to the API (api.<host> → <host>). */
const webUrl = (path: string) => `${appConfig.apiUrl.replace("://api.", "://")}${path}`;

export default function PrivacyScreen() {
  const t = useTranslations();
  const theme = useTheme();
  const me = useMe();
  const consents = useMyConsents();
  const change = useChangeConsent();
  if (!consents.data) {
    if (consents.isError)
      return (
        <Screen>
          <ErrorView error={consents.error} onRetry={() => void consents.refetch()} />
        </Screen>
      );
    return <Loading label={t("common.loading")} />;
  }
  return (
    <Screen testID="privacy-screen">
      <Muted>{t("privacy.intro")}</Muted>
      {change.isError ? (
        <Body style={{ color: theme.colors.danger }}>{t("preferences.errors.failed")}</Body>
      ) : null}
      {consents.data.clubs.length === 0 ? <Muted>{t("privacy.noClubs")}</Muted> : null}
      {consents.data.clubs.map((club) => (
        <Section key={club.clubId} title={club.clubName}>
          {club.people.map(({ person, purposes }) => (
            <View key={person.id}>
              <Row>
                <Body style={{ fontWeight: "600" }}>
                  {person.id === me.data?.personId ? t("privacy.me") : personLabel(person)}
                </Body>
              </Row>
              {purposes.map((p) => {
                const text = club.texts.find((x) => x.purpose === p.purpose);
                const label = t(`consentPurposes.${p.purpose}`);
                const on = p.consent !== null;
                return (
                  <Row key={p.purpose}>
                    <View
                      style={{ flexDirection: "row", alignItems: "center", gap: theme.space(3) }}
                    >
                      <Body style={{ flex: 1 }}>{label}</Body>
                      {p.applicable ? (
                        <Switch
                          value={on}
                          disabled={on ? !p.mayWithdraw : !p.mayGive || !text}
                          accessibilityLabel={label}
                          testID={`consent-${person.id}-${p.purpose}`}
                          onValueChange={(next) =>
                            change.mutate({
                              clubId: club.clubId,
                              personId: person.id,
                              purpose: p.purpose,
                              give: next ? (text?.textVersion ?? null) : null,
                            })
                          }
                        />
                      ) : null}
                    </View>
                    {!p.applicable ? <Muted>{t("privacy.notApplicable")}</Muted> : null}
                    {p.consent && !p.consent.current ? <Muted>{t("privacy.newText")}</Muted> : null}
                    {text ? <Muted>{text.body}</Muted> : null}
                  </Row>
                );
              })}
              <Row>
                <LinkButton
                  label={
                    person.id === me.data?.personId
                      ? t("privacy.leaveSelf", { club: club.clubName })
                      : t("privacy.leaveFor", { club: club.clubName, name: personLabel(person) })
                  }
                  onPress={() =>
                    void Linking.openURL(
                      webUrl(`/me/privacy/leave?clubId=${club.clubId}&personId=${person.id}`),
                    )
                  }
                  testID={`leave-${club.clubId}-${person.id}`}
                />
              </Row>
            </View>
          ))}
          <Row last onPress={() => router.push(`/settings/privacy-policy?clubId=${club.clubId}`)}>
            <Body>{t("privacy.policyLink")}</Body>
          </Row>
        </Section>
      ))}
      <Section title={t("privacy.exports.title")}>
        <Row last>
          <LinkButton
            label={t("privacy.exports.openWeb")}
            onPress={() => void Linking.openURL(webUrl("/me/privacy#exports"))}
            testID="open-data-export"
          />
        </Row>
      </Section>
      <Section title={t("privacy.deletion.title")}>
        <Row last onPress={() => router.push("/settings/delete-account")}>
          <Body>{t("privacy.deletion.open")}</Body>
        </Row>
      </Section>
    </Screen>
  );
}
