// SPDX-License-Identifier: AGPL-3.0-only
// "Mina dokument" (P2.2, ADR 0049 decision 9): the newest files of the
// person's (and their children's) groups and clubs, new ones marked. Cache
// first: the cached list shows at once and refreshes in the background.

import { useTranslations } from "use-intl";

import { useMyDocuments } from "../../../api/queries.ts";
import { DataAge } from "../../../components/data-age.tsx";
import { DocumentRow } from "../../../components/documents.tsx";
import { ErrorView } from "../../../components/error-view.tsx";
import { Button, EmptyState, Loading, Muted, Screen, Section } from "../../../components/ui.tsx";

export default function MyDocuments() {
  const t = useTranslations();
  const documents = useMyDocuments();
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
