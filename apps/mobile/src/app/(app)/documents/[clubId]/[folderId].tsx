// SPDX-License-Identifier: AGPL-3.0-only
// A folder in the app (P2.2, ADR 0049): its subfolders and files; a file
// opens in the browser. Managing folders and uploading happen on the web.

import { router, Stack } from "expo-router";
import { useEffect } from "react";
import { Text } from "react-native";
import { useTranslations } from "use-intl";

import { useFolder, useMarkDocumentsSeen } from "../../../../api/queries.ts";
import { DataAge } from "../../../../components/data-age.tsx";
import { DocumentRow } from "../../../../components/documents.tsx";
import { ErrorView } from "../../../../components/error-view.tsx";
import { useIdParam } from "../../../../components/route-id.ts";
import { EmptyState, Loading, Muted, Row, Screen, Section } from "../../../../components/ui.tsx";
import { useTheme } from "../../../../theme.ts";
import NotFound from "../../../+not-found.tsx";

export default function FolderScreen() {
  const clubId = useIdParam("clubId");
  const folderId = useIdParam("folderId");
  if (!clubId || !folderId) return <NotFound />;
  return <Folder clubId={clubId} folderId={folderId} />;
}

function Folder({ clubId, folderId }: { clubId: string; folderId: string }) {
  const t = useTranslations();
  const theme = useTheme();
  const folder = useFolder(clubId, folderId);
  // Opening a folder of a group (or the club) marks its documents as seen.
  const seen = useMarkDocumentsSeen();
  const groupId = folder.data ? folder.data.folder.groupId : undefined;
  const { mutate } = seen;
  useEffect(() => {
    if (groupId !== undefined) mutate({ clubId, groupId });
  }, [clubId, groupId, mutate]);
  if (!folder.data) {
    if (folder.isError)
      return (
        <Screen>
          <ErrorView error={folder.error} onRetry={() => void folder.refetch()} />
        </Screen>
      );
    return <Loading label={t("common.loading")} />;
  }
  const { subfolders, documents, path } = folder.data;
  return (
    <Screen
      refreshing={folder.isRefetching}
      onRefresh={() => void folder.refetch()}
      testID="folder-screen"
    >
      <Stack.Screen options={{ title: folder.data.folder.name }} />
      <DataAge updatedAt={folder.dataUpdatedAt} />
      {path.length > 1 ? <Muted>{path.map((p) => p.name).join(" / ")}</Muted> : null}
      {subfolders.length > 0 ? (
        <Section title={t("documents.folders")}>
          {subfolders.map((f, index) => (
            <Row
              key={f.id}
              onPress={() => router.push(`/documents/${clubId}/${f.id}`)}
              last={index === subfolders.length - 1}
              testID={`folder-${f.id}`}
            >
              <Text style={{ color: theme.colors.fg, fontWeight: "600" }}>{f.name}</Text>
            </Row>
          ))}
        </Section>
      ) : null}
      <Section title={t("documents.files")}>
        {documents.length === 0 ? (
          <EmptyState title={t("documents.emptyFolder")} />
        ) : (
          documents.map((d, index) => (
            <DocumentRow key={d.id} document={d} last={index === documents.length - 1} />
          ))
        )}
      </Section>
    </Screen>
  );
}
