// SPDX-License-Identifier: AGPL-3.0-only
// A club's privacy policy in the app (P1.8a), in my language, with the
// decision each rule rests on.

import { useLocalSearchParams } from "expo-router";
import { useTranslations } from "use-intl";

import { usePrivacyPolicy } from "../../../api/queries.ts";
import { ErrorView } from "../../../components/error-view.tsx";
import { Body, Loading, Muted, Row, Screen, Section } from "../../../components/ui.tsx";

export default function PrivacyPolicyScreen() {
  const t = useTranslations();
  const { clubId } = useLocalSearchParams<{ clubId: string }>();
  const policy = usePrivacyPolicy(clubId ?? "");
  if (!policy.data) {
    if (policy.isError)
      return (
        <Screen>
          <ErrorView error={policy.error} onRetry={() => void policy.refetch()} />
        </Screen>
      );
    return <Loading label={t("common.loading")} />;
  }
  const p = policy.data;
  return (
    <Screen testID="privacy-policy-screen">
      <Muted>{t("privacy.policy", { version: p.version, date: p.effectiveFrom })}</Muted>
      {p.sections.map((s) => (
        <Section key={s.key} title={s.title}>
          <Row last>
            <Body>{s.body}</Body>
          </Row>
        </Section>
      ))}
    </Screen>
  );
}
