// SPDX-License-Identifier: AGPL-3.0-only
// How chat works and keeps children safe (P2.1 part C, ADR 0047): for
// children in words they understand, then for parents, leaders and the
// club's safeguarding officers. Linked from every chat with children.
import { getTranslations } from "next-intl/server";

export async function generateMetadata() {
  return { title: (await getTranslations())("chatHelp.title") };
}

const SECTIONS = ["children", "parents", "leaders", "reports", "officers", "kept"] as const;

export default async function ChatHelpPage() {
  const t = await getTranslations();
  return (
    <article className="max-w-2xl space-y-4" data-testid="chat-help">
      <h1 className="text-2xl font-semibold">{t("chatHelp.title")}</h1>
      <p>{t("chatHelp.intro")}</p>
      {SECTIONS.map((key) => (
        <section key={key} className="space-y-1">
          <h2 className="text-lg font-semibold">{t(`chatHelp.${key}.title`)}</h2>
          <p className="whitespace-pre-line">{t(`chatHelp.${key}.body`)}</p>
        </section>
      ))}
    </article>
  );
}
