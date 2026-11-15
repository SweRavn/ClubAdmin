// SPDX-License-Identifier: AGPL-3.0-only
// "Mina dokument" (P2.2, ADR 0049 decision 9): the newest files of the
// person's (and their children's) groups and clubs, new ones marked. Cache
// first: the cached list shows at once and refreshes in the background.

import { enumKey } from "@clubadmin/i18n";
import { router } from "expo-router";
import { useTranslations } from "use-intl";

import { useMyDocuments, useMySignatureRequests } from "../../../api/queries.ts";
import { DataAge } from "../../../components/data-age.tsx";
import { DocumentRow } from "../../../components/documents.tsx";
import { ErrorView } from "../../../components/error-view.tsx";
import {
  Button,
  EmptyState,
  Loading,
  Muted,
  Row,
  Screen,
  Section,
} from "../../../components/ui.tsx";

export default function MyDocuments() {
  const t = useTranslations();
  const documents = useMyDocuments();
  // Waiting for my signature (P2.4): read in the app, signed on the web.
  const waiting = useMySignatureRequests();
  if (!documents.data) {
    if (documents.isError)
      return (
        <Screen>
          <ErrorView error={documents.error} onRetry={() => void documents.refetch()} />
        </Screen>
      );
    return <Loading label={t("common.loading")} />;
  }
  const items = documents.data.pages.flatMap((page) => page.items);
  return (
    <Screen
      refreshing={documents.isRefetching}
      onRefresh={() => void documents.refetch()}
      testID="documents-screen"
    >
      <DataAge updatedAt={documents.dataUpdatedAt} />
      <Muted>{t("documents.mineIntro")}</Muted>
      {waiting.data && waiting.data.items.length > 0 ? (
        <Section title={t("governing.waitingForMe")}>
          {waiting.data.items.map((w, index) => (
            <Row
              key={w.signatureId}
              onPress={() => router.push(`/governing/${w.clubId}/${w.documentId}`)}
              accessibilityLabel={w.documentName}
              last={index === waiting.data.items.length - 1}
              testID={`waiting-${w.documentId}`}
            >
              <Muted>{`${w.documentName} · ${w.clubName} · ${t(enumKey("governing.signerRoles", w.role))}`}</Muted>
            </Row>
          ))}
        </Section>
      ) : null}
      <Section title={t("documents.mine")}>
        {items.length === 0 ? (
          <EmptyState title={t("documents.mineEmpty")} />
        ) : (
          items.map((item, index) => (
            <DocumentRow
              key={item.document.id}
              document={item.document}
              context={item.groupName ?? item.clubName}
              isNew={item.isNew}
              last={index === items.length - 1}
            />
          ))
        )}
      </Section>
      {documents.hasNextPage ? (
        <Button
          label={t("documents.more")}
          kind="secondary"
          busy={documents.isFetchingNextPage}
          onPress={() => void documents.fetchNextPage()}
          testID="documents-more"
        />
      ) : null}
    </Screen>
  );
}
