// SPDX-License-Identifier: AGPL-3.0-only
// A group's documents (P2.2, ADR 0049): its top-level folders the viewer
// reads; its leaders (and owners) create folders, by default for the group.
// Opening the page marks the group's documents as seen.
import { EmptyState } from "@clubadmin/ui";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { ActionForm, buttonClass, inputClass } from "../../../../../components/action-form.tsx";
import { FormError, Notice } from "../../../../../components/form-error.tsx";
import { getGroup, getGroupFolders, markDocumentsSeen } from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ groupId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("documents.title") };
}

export default async function GroupDocumentsPage({ params, searchParams }: Props) {
  const [{ groupId }, query] = await Promise.all([params, searchParams]);
  const [t, group] = await Promise.all([getTranslations(), getGroup(groupId)]);
  const folders = await getGroupFolders(group.clubId, group.id);
  if (!folders) notFound();
  await markDocumentsSeen(group.clubId, group.id);
  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted">
          <a href={`/groups/${group.id}`} className="underline">
            {group.name}
          </a>
        </p>
        <h1 className="text-2xl font-semibold">{t("documents.title")}</h1>
        <p className="mt-1 max-w-prose text-sm text-muted">{t("documents.groupIntro")}</p>
      </div>
      <FormError code={query.error} />
      {query.deleted ? <Notice>{t("documents.deleted")}</Notice> : null}
      {folders.items.length > 0 ? (
        <ul className="divide-y divide-border" data-testid="folders">
          {folders.items.map((f) => (
            <li key={f.id} className="py-2">
              <a href={`/clubs/${group.clubId}/folders/${f.id}`} className="font-medium underline">
                {f.name}
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title={t("documents.noFolders")} />
      )}
      {folders.canManage ? (
        <section aria-labelledby="new-folder" className="space-y-3">
          <h2 id="new-folder" className="text-lg font-semibold">
            {t("documents.newFolder")}
          </h2>
          <ActionForm action="documents-create-folder" className="space-y-3" testId="new-folder">
            <input type="hidden" name="clubId" value={group.clubId} />
            <input type="hidden" name="groupId" value={group.id} />
            <label className="block text-sm">
              {t("documents.folderName")}
              <input name="name" required maxLength={120} className={inputClass} />
            </label>
            <p className="text-xs text-muted">{t("documents.groupFolderAudience")}</p>
            <button type="submit" className={buttonClass}>
              {t("documents.createFolder")}
            </button>
          </ActionForm>
        </section>
      ) : null}
    </div>
  );
}
