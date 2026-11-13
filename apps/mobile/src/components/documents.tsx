// SPDX-License-Identifier: AGPL-3.0-only
// Files in the app (P2.2, ADR 0049): a row per file that opens its current
// version through a short-lived link in the browser (the app stores no
// files). Files not clean yet show their state instead.

import { enumKey } from "@clubadmin/i18n";
import { Linking, Text } from "react-native";
import { useLocale, useTranslations } from "use-intl";

import { useDocumentLink } from "../api/queries.ts";
import { useTheme } from "../theme.ts";
import { Muted, Row } from "./ui.tsx";

export function formatSize(bytes: number, locale: string): string {
  const units = ["B", "kB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value)} ${units[unit]}`;
}

/** What a row shows of a file (the API's DocumentSummary has more). */
type RowDocument = {
  id: string;
  clubId: string;
  name: string;
  current: { size: number } | null;
  latest: { status: string } | null;
};

export function DocumentRow({
  document,
  context,
  isNew,
  last,
}: {
  document: RowDocument;
  /** The group or club it belongs to ("Mina dokument"). */
  context?: string | null;
  isNew?: boolean;
  last?: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const theme = useTheme();
  const link = useDocumentLink();
  const current = document.current;
  const open = () =>
    link.mutate(
      { clubId: document.clubId, documentId: document.id },
      { onSuccess: (result) => void Linking.openURL(result.url) },
    );
  const details = [
    context,
    current ? formatSize(current.size, locale) : null,
    !current && document.latest ? t(enumKey("documents.states", document.latest.status)) : null,
  ].filter(Boolean);
  return (
    <Row
      {...(current ? { onPress: open } : {})}
      accessibilityLabel={`${t("documents.download")}: ${document.name}`}
      last={last ?? false}
      testID={`document-${document.id}`}
    >
      <Text style={{ color: theme.colors.fg, fontWeight: "600" }}>
        {document.name}
        {isNew ? (
          <Text style={{ color: theme.colors.accent }} testID="document-new">
            {`  ${t("documents.new")}`}
          </Text>
        ) : null}
      </Text>
      {details.length > 0 ? <Muted>{details.join(" · ")}</Muted> : null}
      {link.isError ? <Muted>{t("documents.openFailed")}</Muted> : null}
    </Row>
  );
}
