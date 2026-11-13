// SPDX-License-Identifier: AGPL-3.0-only
// A file (P2.2, ADR 0049): its versions with downloads and scan state; those
// who manage it upload a new version, rename it, set a deletion date,
// change to whom it is shown and delete it.
import { formatDateTime, personLabel } from "@clubadmin/ui";
import { getLocale, getTimeZone, getTranslations } from "next-intl/server";

import {
  ActionForm,
  buttonClass,
  inputClass,
  secondaryButtonClass,
} from "../../../../../../components/action-form.tsx";
import {
  AudienceFields,
  AudienceText,
  downloadHref,
  formatSize,
  UploadForm,
  VersionState,
} from "../../../../../../components/documents.tsx";
import { FormError, Notice } from "../../../../../../components/form-error.tsx";
import {
  getClubGroups,
  getClubRolesIfAllowed,
  getDocument,
} from "../../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string; documentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props) {
  const { clubId, documentId } = await params;
  return { title: (await getDocument(clubId, documentId)).document.name };
}

export default async function DocumentPage({ params, searchParams }: Props) {
  const [{ clubId, documentId }, query] = await Promise.all([params, searchParams]);
  const [t, locale, timeZone, detail] = await Promise.all([
    getTranslations(),
    getLocale(),
    getTimeZone(),
    getDocument(clubId, documentId),
  ]);
  const { document } = detail;
  const [roles, groups] = await Promise.all([
    getClubRolesIfAllowed(clubId),
    detail.canManage ? getClubGroups(clubId) : Promise.resolve([]),
  ]);
  const after = `/clubs/${clubId}/folders/${document.folderId}`;
  return (
    <div className="space-y-6">
      <div>
        <nav aria-label={t("documents.path")} className="text-sm text-muted">
          {detail.path.map((p, i) => (
            <span key={p.id}>
              {i > 0 ? " / " : ""}
              <a href={`/clubs/${clubId}/folders/${p.id}`} className="underline">
                {p.name}
              </a>
            </span>
          ))}
        </nav>
        <h1 className="text-2xl font-semibold">{document.name}</h1>
        <AudienceText entries={detail.audience} roles={roles?.items ?? null} />
        {document.deleteAfter ? (
          <p className="text-sm text-muted" data-testid="delete-after">
            {t("documents.deleteAfterNote", {
              day: formatDateTime(`${document.deleteAfter}T12:00:00Z`, {
                locale,
                timeZone,
                dateStyle: "long",
              }),
            })}
          </p>
        ) : null}
      </div>
      <FormError code={query.error} />
      {query.uploaded ? <Notice>{t("documents.uploaded")}</Notice> : null}
      {query.saved ? <Notice>{t("documents.saved")}</Notice> : null}
      {document.current ? (
        <a
          href={downloadHref(clubId, document.id)}
          className={buttonClass}
          data-testid="download-current"
        >
          {t("documents.downloadCurrent", { size: formatSize(document.current.size, locale) })}
        </a>
      ) : (
        <p className="text-sm text-muted">{t("documents.notReady")}</p>
      )}
      <section aria-labelledby="versions" className="space-y-2">
        <h2 id="versions" className="text-lg font-semibold">
          {t("documents.versions")}
        </h2>
        <ol className="divide-y divide-border" data-testid="versions">
          {detail.versions.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
              <span className="font-medium">{t("documents.version", { number: v.number })}</span>
              <span className="text-muted">
                {v.fileName} · {formatSize(v.size, locale)}
                {v.uploadedAt
                  ? ` · ${formatDateTime(v.uploadedAt, { locale, timeZone, dateStyle: "medium", timeStyle: "short" })}`
                  : ""}
                {v.uploadedBy ? ` · ${personLabel(v.uploadedBy)}` : ""}
              </span>
              <VersionState version={v} />
              {v.status === "clean" ? (
                <a href={downloadHref(clubId, document.id, v.id)} className="ml-auto underline">
                  {t("documents.download")}
                </a>
              ) : null}
            </li>
          ))}
        </ol>
      </section>
      {detail.canManage ? (
        <>
          <section aria-labelledby="new-version" className="space-y-3">
            <h2 id="new-version" className="text-lg font-semibold">
              {t("documents.newVersion")}
            </h2>
            <UploadForm clubId={clubId} target="document" targetId={document.id} newFile={false} />
          </section>
          <section aria-labelledby="document-settings" className="space-y-3">
            <h2 id="document-settings" className="text-lg font-semibold">
              {t("documents.documentSettings")}
            </h2>
            <ActionForm action="documents-update" className="space-y-3" testId="document-settings">
              <input type="hidden" name="clubId" value={clubId} />
              <input type="hidden" name="documentId" value={document.id} />
              <label className="block text-sm">
                {t("documents.fileName")}
                <input
                  name="name"
                  required
                  maxLength={200}
                  defaultValue={document.name}
                  className={inputClass}
                />
              </label>
              <label className="block text-sm">
                {t("documents.deleteAfter")}
                <input
                  type="date"
                  name="deleteAfter"
                  defaultValue={document.deleteAfter ?? ""}
                  className={inputClass}
                />
                <span className="mt-1 block text-xs text-muted">
                  {t("documents.deleteAfterHelp")}
                </span>
              </label>
              <AudienceFields
                current={document.ownAudience ? detail.audience : []}
                inherit
                groups={groups.map((g) => ({ id: g.id, name: g.name }))}
                roles={roles?.items ?? null}
                groupId={null}
              />
              <button type="submit" className={buttonClass}>
                {t("documents.save")}
              </button>
            </ActionForm>
            <ActionForm action="documents-delete" testId="delete-document">
              <input type="hidden" name="clubId" value={clubId} />
              <input type="hidden" name="documentId" value={document.id} />
              <input type="hidden" name="after" value={after} />
              <button type="submit" className={secondaryButtonClass}>
                {t("documents.deleteDocument")}
              </button>
            </ActionForm>
          </section>
        </>
      ) : null}
    </div>
  );
}
