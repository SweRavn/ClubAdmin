// SPDX-License-Identifier: AGPL-3.0-only
// The club's documents (P2.2, ADR 0049): its top-level folders the viewer
// reads; those who manage the club's archive create folders and see the
// storage. Opening the page marks the club's documents as seen.
import { EmptyState } from "@clubadmin/ui";
import { getTranslations } from "next-intl/server";

import {
  ActionForm,
  buttonClass,
  inputClass,
  secondaryButtonClass,
} from "../../../../../components/action-form.tsx";
import { AudienceFields } from "../../../../../components/documents.tsx";
import { FormError, Notice } from "../../../../../components/form-error.tsx";
import {
  getClub,
  getClubFolders,
  getClubGroups,
  markDocumentsSeen,
} from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("documents.title") };
}

export default async function ClubDocumentsPage({ params, searchParams }: Props) {
  const [{ clubId }, query] = await Promise.all([params, searchParams]);
  const [t, club, folders] = await Promise.all([
    getTranslations(),
    getClub(clubId),
    getClubFolders(clubId),
  ]);
  await markDocumentsSeen(club.id, null);
  const groups = folders.canManage ? await getClubGroups(club.id) : [];
  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted">
          <a href={`/clubs/${club.id}`} className="underline">
            {club.name}
          </a>
        </p>
        <h1 className="text-2xl font-semibold">{t("documents.title")}</h1>
        <p className="mt-1 max-w-prose text-sm text-muted">{t("documents.intro")}</p>
      </div>
      <FormError code={query.error} />
      {query.deleted ? <Notice>{t("documents.deleted")}</Notice> : null}
      {folders.items.length > 0 ? (
        <ul className="divide-y divide-border" data-testid="folders">
          {folders.items.map((f) => (
            <li key={f.id} className="py-2">
              <a href={`/clubs/${club.id}/folders/${f.id}`} className="font-medium underline">
                {f.name}
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title={t("documents.noFolders")} />
      )}
      {folders.canManage ? (
        <>
          <section aria-labelledby="new-folder" className="space-y-3">
            <h2 id="new-folder" className="text-lg font-semibold">
              {t("documents.newFolder")}
            </h2>
            <ActionForm action="documents-create-folder" className="space-y-3" testId="new-folder">
              <input type="hidden" name="clubId" value={club.id} />
              <label className="block text-sm">
                {t("documents.folderName")}
                <input name="name" required maxLength={120} className={inputClass} />
              </label>
              <AudienceFields
                current={[{ kind: "club", groupId: null, groupName: null, roleIds: [] }]}
                inherit={false}
                groups={groups.map((g) => ({ id: g.id, name: g.name }))}
                roles={null}
                groupId={null}
              />
              <button type="submit" className={buttonClass}>
                {t("documents.createFolder")}
              </button>
            </ActionForm>
          </section>
          <a href={`/clubs/${club.id}/storage`} className={secondaryButtonClass}>
            {t("documents.storage.title")}
          </a>
        </>
      ) : null}
    </div>
  );
}
