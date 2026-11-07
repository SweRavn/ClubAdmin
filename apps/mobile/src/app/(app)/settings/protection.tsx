// SPDX-License-Identifier: AGPL-3.0-only
// Privacy and protection in the app (P1.12, ADR 0022): the caller's
// protected identity; who has viewed the profile and what the crossed-out
// camera means open on the web. Children's protection is in Family.

import { Linking } from "react-native";
import { useTranslations } from "use-intl";

import { useMe } from "../../../api/queries.ts";
import { useProtectScreen } from "../../../components/protect-screen.ts";
import { ProtectionToggle } from "../../../components/protection-toggle.tsx";
import { LinkButton, Loading, Muted, Screen, Section } from "../../../components/ui.tsx";
import { appConfig } from "../../../config.ts";

/** The web app next to the API (api.<host> → <host>). */
const webUrl = (path: string) => `${appConfig.apiUrl.replace("://api.", "://")}${path}`;

export default function ProtectionScreen() {
  const t = useTranslations();
  const me = useMe();
  useProtectScreen(me.data?.person.protected === true, "protection");
  if (!me.data) return <Loading label={t("common.loading")} />;
  const personId = me.data.personId;
  return (
    <Screen testID="protection-screen">
      <Section title={t("protection.name")}>
        <ProtectionToggle personId={personId} testID="my-protection" />
      </Section>
      <Section title={t("protection.accessLog")}>
        <Muted>{t("protection.accessLogIntro")}</Muted>
        <LinkButton
          label={t("protection.openOnWeb")}
          onPress={() => void Linking.openURL(webUrl(`/people/${personId}/access-log`))}
          testID="open-access-log"
        />
      </Section>
      <LinkButton
        label={t("protection.help")}
        onPress={() => void Linking.openURL(webUrl("/help/protected-identity"))}
      />
    </Screen>
  );
}
