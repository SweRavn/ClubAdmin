// SPDX-License-Identifier: AGPL-3.0-only
// About: version, the AGPL "Source code" link (the running server's exact
// source, /meta/source, else the project), and the third-party licences in
// the app's dependency tree (generated from the lockfile,
// scripts/generate-licenses.mts; CI keeps it current).

import * as Updates from "expo-updates";
import { FlatList, Linking, View } from "react-native";
import { useTranslations } from "use-intl";

import { useSource } from "../../../api/queries.ts";
import { appVersion } from "../../../components/gates.tsx";
import { Body, Button, Heading, Muted, Row, Section } from "../../../components/ui.tsx";
import { appConfig } from "../../../config.ts";
import licences from "../../../licenses.json";
import { useTheme } from "../../../theme.ts";

type Licence = [name: string, version: string, license: string];
const packages = licences.packages as Licence[];

export default function About() {
  const t = useTranslations();
  const theme = useTheme();
  const source = useSource();
  const sourceUrl = source.data?.url ?? appConfig.sourceUrl;
  return (
    <FlatList
      style={{ flex: 1, backgroundColor: theme.colors.bg }}
      contentContainerStyle={{ padding: theme.space(4) }}
      data={packages}
      keyExtractor={([name, version]) => `${name}@${version}`}
      initialNumToRender={20}
      testID="about-screen"
      ListHeaderComponent={
        <View style={{ gap: theme.space(5), marginBottom: theme.space(3) }}>
          <Section title={t("common.appName")}>
            <Row>
              <Muted>{t("footer.version", { version: appVersion() })}</Muted>
              {Updates.updateId ? (
                <Muted>{t("mobile.update", { id: Updates.updateId.slice(0, 8) })}</Muted>
              ) : null}
            </Row>
            <Row last>
              <Body>{t("footer.licence")}</Body>
            </Row>
          </Section>
          <Button
            label={t("footer.source")}
            kind="secondary"
            onPress={() => void Linking.openURL(sourceUrl)}
            testID="source-link"
          />
          <Heading level={2}>{t("mobile.licences")}</Heading>
        </View>
      }
      renderItem={({ item: [name, version, license] }) => (
        <Row>
          <Body>{`${name} ${version}`}</Body>
          <Muted>{license}</Muted>
        </Row>
      )}
    />
  );
}
