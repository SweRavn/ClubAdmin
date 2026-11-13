// SPDX-License-Identifier: AGPL-3.0-only
// The documents attached to an activity's or event's notice (P2.2): shown
// when there are any; attaching happens on the web.

import { useTranslations } from "use-intl";

import { useNoticeAttachments } from "../api/queries.ts";
import { DocumentRow } from "./documents.tsx";
import { Section } from "./ui.tsx";

export function NoticeDocuments({
  kind,
  noticeId,
}: {
  kind: "activities" | "events";
  noticeId: string;
}) {
  const t = useTranslations();
  const attachments = useNoticeAttachments(kind, noticeId);
  const items = attachments.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <Section title={t("documents.notice.title")}>
      {items.map((a, index) => (
        <DocumentRow key={a.document.id} document={a.document} last={index === items.length - 1} />
      ))}
    </Section>
  );
}
