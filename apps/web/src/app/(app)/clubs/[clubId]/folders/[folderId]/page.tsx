// SPDX-License-Identifier: AGPL-3.0-only
// A folder (P2.2, ADR 0049): its path, to whom it is shown, subfolders and
// files; those who manage it upload, create subfolders, rename, change the
// audience and delete it.
import { EmptyState } from "@clubadmin/ui";
import { getTranslations } from "next-intl/server";

import {
  ActionForm,
  buttonClass,
  inputClass,
  secondaryButtonClass,
} from "../../../../../../components/action-form.tsx";
import {
  AudienceFields,
  AudienceText,
  FileList,
  UploadForm,
} from "../../../../../../components/documents.tsx";
import { FormError, Notice } from "../../../../../../components/form-error.tsx";
import { getClubGroups, getClubRolesIfAllowed, getFolder } from "../../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string; folderId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props) {
  const { clubId, folderId } = await params;
  return { title: (await getFolder(clubId, folderId, null)).folder.name };
}

export default async function FolderPage({ params, searchParams }: Props) {
  const [{ clubId, folderId }, query] = await Promise.all([params, searchParams]);
  const cursor = typeof query.cursor === "string" ? query.cursor : null;
  const [t, content] = await Promise.all([getTranslations(), getFolder(clubId, folderId, cursor)]);
  const { folder } = content;
  const [roles, groups] = await Promise.all([
    getClubRolesIfAllowed(clubId),
    content.canManage ? getClubGroups(clubId) : Promise.resolve([]),
  ]);
  const top = folder.groupId ? `/groups/${folder.groupId}/documents` : `/clubs/${clubId}/documents`;
  const parent = content.path.length > 1 ? content.path[content.path.length - 2] : null;
  const after = parent ? `/clubs/${clubId}/folders/${parent.id}` : top;
  const groupOptions = groups.map((g) => ({ id: g.id, name: g.name }));
  return (
    <div className="space-y-6">
      <div>
        <nav aria-label={t("documents.path")} className="text-sm text-muted">
          <a href={top} className="underline">
            {t("documents.title")}
          </a>
          {content.path.slice(0, -1).map((p) => (
            <span key={p.id}>
              {" / "}
              <a href={`/clubs/${clubId}/folders/${p.id}`} className="underline">
                {p.name}
              </a>
            </span>
          ))}
        </nav>
        <h1 className="text-2xl font-semibold">{folder.name}</h1>
        <AudienceText entries={content.audience} roles={roles?.items ?? null} />
      </div>
      <FormError code={query.error} />
      {query.uploaded ? <Notice>{t("documents.uploaded")}</Notice> : null}
      {query.saved ? <Notice>{t("documents.saved")}</Notice> : null}
      {query.deleted ? <Notice>{t("documents.deleted")}</Notice> : null}
      {content.subfolders.length > 0 ? (
        <ul className="divide-y divide-border" data-testid="subfolders">
          {content.subfolders.map((f) => (
            <li key={f.id} className="py-2">
              <a href={`/clubs/${clubId}/folders/${f.id}`} className="font-medium underline">
                {f.name}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {content.documents.length > 0 ? (
        <FileList clubId={clubId} documents={content.documents} />
      ) : content.subfolders.length === 0 ? (
        <EmptyState title={t("documents.emptyFolder")} />
      ) : null}
      {content.nextCursor ? (
        <a
          href={`/clubs/${clubId}/folders/${folder.id}?cursor=${content.nextCursor}`}
          className="text-sm underline"
        >
          {t("documents.more")}
        </a>
      ) : null}
      {content.canManage ? (
        <>
          <section aria-labelledby="upload" className="space-y-3">
            <h2 id="upload" className="text-lg font-semibold">
              {t("documents.upload.title")}
            </h2>
            <UploadForm clubId={clubId} target="folder" targetId={folder.id} newFile />
          </section>
          <section aria-labelledby="new-folder" className="space-y-3">
            <h2 id="new-folder" className="text-lg font-semibold">
              {t("documents.newSubfolder")}
            </h2>
            <ActionForm action="documents-create-folder" className="flex flex-wrap gap-2">
              <input type="hidden" name="clubId" value={clubId} />
              <input type="hidden" name="parentId" value={folder.id} />
              <label className="text-sm">
                <span className="sr-only">{t("documents.folderName")}</span>
                <input
                  name="name"
                  required
                  maxLength={120}
                  placeholder={t("documents.folderName")}
                  className={inputClass}
                />
              </label>
              <button type="submit" className={secondaryButtonClass}>
                {t("documents.createFolder")}
              </button>
            </ActionForm>
          </section>
          <section aria-labelledby="folder-settings" className="space-y-3">
            <h2 id="folder-settings" className="text-lg font-semibold">
              {t("documents.folderSettings")}
            </h2>
            <ActionForm
              action="documents-update-folder"
              className="space-y-3"
              testId="folder-settings"
            >
              <input type="hidden" name="clubId" value={clubId} />
              <input type="hidden" name="folderId" value={folder.id} />
              <label className="block text-sm">
                {t("documents.folderName")}
                <input
                  name="name"
                  required
                  maxLength={120}
                  defaultValue={folder.name}
                  className={inputClass}
                />
              </label>
              <AudienceFields
                current={folder.ownAudience || !folder.parentId ? content.audience : []}
                inherit={folder.parentId !== null}
                groups={groupOptions}
                roles={roles?.items ?? null}
                groupId={folder.groupId}
              />
              <button type="submit" className={buttonClass}>
                {t("documents.save")}
              </button>
            </ActionForm>
            <ActionForm
              action="documents-delete-folder"
              className="space-y-2"
              testId="delete-folder"
            >
              <input type="hidden" name="clubId" value={clubId} />
              <input type="hidden" name="folderId" value={folder.id} />
              <input type="hidden" name="after" value={after} />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="confirm" value="true" />
                {t("documents.deleteFolderContent")}
              </label>
              <button type="submit" className={secondaryButtonClass}>
                {t("documents.deleteFolder")}
              </button>
            </ActionForm>
          </section>
        </>
      ) : null}
    </div>
  );
}
