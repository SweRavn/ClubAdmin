// SPDX-License-Identifier: AGPL-3.0-only
// A governing document in the app (P2.4): the text in force (statutes,
// minutes), and for a named signer the draft and who has signed. Signing
// needs a recent login with a second factor and happens on the web; the
// app says so. Cache first.
import { enumKey } from "@clubadmin/i18n";
import { personLabel } from "@clubadmin/shared";
import { useLocalSearchParams } from "expo-router";
import { useFormatter, useTranslations } from "use-intl";

import { useGoverningDocument } from "../../../../api/queries.ts";
import { DataAge } from "../../../../components/data-age.tsx";
import { ErrorView } from "../../../../components/error-view.tsx";
import { Markdown } from "../../../../components/markdown.tsx";
import { Heading, Loading, Muted, Screen, Section } from "../../../../components/ui.tsx";

export default function GoverningDocumentScreen() {
  const t = useTranslations();
  const format = useFormatter();
  const { clubId, documentId } = useLocalSearchParams<{ clubId: string; documentId: string }>();
  const doc = useGoverningDocument(clubId, documentId);
  if (!doc.data) {
    if (doc.isError)
      return (
        <Screen>
          <ErrorView error={doc.error} onRetry={() => void doc.refetch()} />
        </Screen>
      );
    return <Loading label={t("common.loading")} />;
  }
  const d = doc.data;
  const shown = d.current ?? d.draft;
  return (
    <Screen
      refreshing={doc.isRefetching}
      onRefresh={() => void doc.refetch()}
      testID="governing-screen"
    >
      <DataAge updatedAt={doc.dataUpdatedAt} />
      <Heading>{d.name}</Heading>
      <Muted>{`${d.series.name} · ${t(enumKey("governing.statuses", d.status))}`}</Muted>
      {shown ? (
        <Section title={d.current ? t("governing.current") : t("governing.draft")}>
          <Markdown source={shown.body} settings testID="governing-text" />
        </Section>
      ) : (
        <Muted>{t("governing.noCurrent")}</Muted>
      )}
      {d.draft && d.draft.signers.length > 0 ? (
        <Section title={t("governing.signers")}>
          {d.draft.signers.map((s) => (
            <Muted key={s.signatureId}>
              {[
                s.person ? personLabel(s.person) : "–",
                t(enumKey("governing.signerRoles", s.role)),
                s.signedAt
                  ? t("governing.signedAt", {
                      date: format.dateTime(new Date(s.signedAt), { dateStyle: "medium" }),
                    })
                  : t("governing.waiting"),
              ].join(" · ")}
            </Muted>
          ))}
          {d.draft.signers.some((s) => s.mine) ? <Muted>{t("governing.signOnWeb")}</Muted> : null}
        </Section>
      ) : null}
    </Screen>
  );
}
