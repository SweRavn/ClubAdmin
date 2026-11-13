// SPDX-License-Identifier: AGPL-3.0-only
// The file archive's parts (P2.2, ADR 0049): file lists with their scan
// state, who a folder or file is shown to, the audience editor, the upload
// form (posted to the upload route: the web server puts the file to the
// storage) and a notice's documents. Uploaders come from the API through
// the PersonPresenter; file and folder names are the club's own text.
import { enumKey } from "@clubadmin/i18n";
import type {
  AudienceEntry,
  DocumentSummary,
  DocumentVersion,
  NoticeAttachmentList,
  Role,
} from "@clubadmin/shared";
import { DOCUMENT_FILE_TYPES, DOCUMENT_MAX_BYTES } from "@clubadmin/shared";
import { formatDateTime, personLabel } from "@clubadmin/ui";
import { getLocale, getTimeZone, getTranslations } from "next-intl/server";

import {
  currentPath,
  getMyDocuments,
  getNoticeAttachments,
  requireSession,
} from "../server/data.ts";
import { ActionForm, buttonClass, inputClass, secondaryButtonClass } from "./action-form.tsx";
import { roleName } from "./roles.ts";

/** A size in kB or MB in the viewer's language. */
export function formatSize(bytes: number, locale: string): string {
  const unit = bytes >= 1024 * 1024 ? "megabyte" : "kilobyte";
  const value = unit === "megabyte" ? bytes / (1024 * 1024) : Math.max(bytes / 1024, 0.1);
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay: "short",
    maximumFractionDigits: 1,
  }).format(value);
}

export const downloadHref = (clubId: string, documentId: string, versionId?: string) =>
  `/clubs/${clubId}/documents/${documentId}/download${versionId ? `?version=${versionId}` : ""}`;

/** A version's state when it is not visible (yet): being uploaded or scanned, or refused. */
export async function VersionState({ version }: { version: DocumentVersion }) {
  if (version.status === "clean") return null;
  const t = await getTranslations();
  const tone =
    version.status === "infected" || version.status === "failed"
      ? "bg-danger/10 text-danger"
      : "bg-surface text-muted";
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs ${tone}`} data-testid="version-state">
      {t(enumKey("documents.states", version.status))}
    </span>
  );
}

/** A folder's or notice's files: name, size, date, uploader, state, download. */
export async function FileList({
  clubId,
  documents,
  testId,
}: {
  clubId: string;
  documents: readonly DocumentSummary[];
  testId?: string;
}) {
  const [t, locale, timeZone] = await Promise.all([getTranslations(), getLocale(), getTimeZone()]);
  return (
    <ul className="divide-y divide-border" data-testid={testId ?? "documents"}>
      {documents.map((d) => {
        const shown = d.current ?? d.latest;
        return (
          <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
            <a href={`/clubs/${clubId}/documents/${d.id}`} className="font-medium underline">
              {d.name}
            </a>
            {shown ? (
              <span className="text-sm text-muted">
                {formatSize(shown.size, locale)} ·{" "}
                {formatDateTime(shown.uploadedAt ?? shown.createdAt, {
                  locale,
                  timeZone,
                  dateStyle: "medium",
                })}
                {shown.uploadedBy ? ` · ${personLabel(shown.uploadedBy)}` : ""}
              </span>
            ) : null}
            {d.latest ? <VersionState version={d.latest} /> : null}
            {d.current ? (
              <a
                href={downloadHref(clubId, d.id)}
                className="ml-auto text-sm underline"
                data-testid="download"
              >
                {t("documents.download")}
              </a>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Who sees a folder or file, in words (group names; roles by their names when known). */
export async function AudienceText({
  entries,
  roles,
}: {
  entries: readonly AudienceEntry[];
  roles: readonly Role[] | null;
}) {
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const roleLabel = (id: string) => {
    const role = roles?.find((r) => r.id === id);
    return role ? roleName(t, locale, role) : t("documents.audience.aRole");
  };
  const parts = entries.map((e) => {
    switch (e.kind) {
      case "club":
        return t("documents.audience.club");
      case "public":
        return t("documents.audience.public");
      case "group":
        return t("documents.audience.group", { group: e.groupName ?? "" });
      case "group_roles":
        return t("documents.audience.groupRoles", {
          group: e.groupName ?? "",
          roles: e.roleIds.map(roleLabel).join(", "),
        });
      case "club_role":
        return t("documents.audience.clubRole", { role: e.roleIds.map(roleLabel).join(", ") });
      default:
        return "";
    }
  });
  return (
    <p className="text-sm text-muted" data-testid="audience">
      {t("documents.audience.shownTo", { who: parts.filter(Boolean).join(" · ") })}
    </p>
  );
}

/**
 * The audience editor: the whole club, public, the group's leaders, chosen
 * groups and club roles, or (subfolders and files) what applies above.
 */
export async function AudienceFields({
  current,
  inherit,
  groups,
  roles,
  groupId,
}: {
  /** The entries that apply now (to preselect). */
  current: readonly AudienceEntry[];
  /** Offer "as the folder above". */
  inherit: boolean;
  groups: readonly { id: string; name: string }[];
  roles: readonly Role[] | null;
  /** The folder's group: offers "the group's leaders". */
  groupId: string | null;
}) {
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const kinds = new Set(current.map((e) => e.kind));
  const mode = kinds.has("public")
    ? "public"
    : kinds.has("club")
      ? "club"
      : kinds.has("group_roles")
        ? "leaders"
        : current.length > 0
          ? "custom"
          : inherit
            ? "inherit"
            : "club";
  const chosenGroups = new Set(current.filter((e) => e.kind === "group").map((e) => e.groupId));
  const chosenRoles = new Set(
    current.filter((e) => e.kind === "club_role").flatMap((e) => e.roleIds),
  );
  const leaderRoles = (roles ?? []).filter(
    (r) => r.scope === "group" && r.permissions.includes("group.lead"),
  );
  const clubRoles = (roles ?? []).filter((r) => r.scope === "club");
  const option = (value: string, label: string) => (
    <label className="flex items-center gap-2">
      <input type="radio" name="audience" value={value} defaultChecked={mode === value} />
      {label}
    </label>
  );
  return (
    <fieldset className="space-y-2" data-testid="audience-fields">
      <legend className="text-sm font-medium">{t("documents.audience.legend")}</legend>
      {inherit ? option("inherit", t("documents.audience.inherit")) : null}
      {option("club", t("documents.audience.club"))}
      {groupId && leaderRoles.length > 0 ? (
        <>
          {option("leaders", t("documents.audience.leaders"))}
          <input type="hidden" name="audienceGroupId" value={groupId} />
          {leaderRoles.map((r) => (
            <input key={r.id} type="hidden" name="leaderRole" value={r.id} />
          ))}
        </>
      ) : null}
      {option("custom", t("documents.audience.custom"))}
      <div className="ml-6 grid gap-1 sm:grid-cols-2">
        {groups.map((g) => (
          <label key={g.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="audienceGroup"
              value={g.id}
              defaultChecked={chosenGroups.has(g.id)}
            />
            {g.name}
          </label>
        ))}
        {clubRoles.map((r) => (
          <label key={r.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="audienceRole"
              value={r.id}
              defaultChecked={chosenRoles.has(r.id)}
            />
            {roleName(t, locale, r)}
          </label>
        ))}
      </div>
      {option("public", t("documents.audience.public"))}
      <p className="text-xs text-muted">{t("documents.audience.guardians")}</p>
    </fieldset>
  );
}

const ACCEPT = Object.keys(DOCUMENT_FILE_TYPES)
  .map((e) => `.${e}`)
  .join(",");

/** Upload a file (posted to the upload route with the session's CSRF token). */
export async function UploadForm({
  clubId,
  target,
  targetId,
  newFile,
}: {
  clubId: string;
  target: "folder" | "document" | "activity" | "event";
  targetId: string;
  /** A new file (a name and push may be given), not a new version. */
  newFile: boolean;
}) {
  const [t, session, path] = await Promise.all([
    getTranslations(),
    requireSession(),
    currentPath(),
  ]);
  const back = new URL(path, "https://internal.invalid");
  for (const key of ["error", "uploaded", "saved", "deleted"]) back.searchParams.delete(key);
  return (
    <form
      method="post"
      action={`/clubs/${clubId}/documents/upload`}
      encType="multipart/form-data"
      className="space-y-2 rounded-md border border-border p-3"
      data-testid="upload-form"
    >
      <input type="hidden" name="csrf" value={session.record.csrf} />
      <input type="hidden" name="back" value={`${back.pathname}${back.search}`} />
      <input type="hidden" name="target" value={target} />
      <input type="hidden" name="targetId" value={targetId} />
      <label className="block text-sm">
        {newFile ? t("documents.upload.file") : t("documents.upload.version")}
        <input type="file" name="file" required accept={ACCEPT} className="mt-1 block text-sm" />
      </label>
      {newFile ? (
        <>
          <label className="block text-sm">
            {t("documents.upload.name")}
            <input name="name" maxLength={200} className={inputClass} />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="notify" value="true" />
            {t("documents.upload.notify")}
          </label>
        </>
      ) : null}
      <p className="text-xs text-muted">
        {t("documents.upload.help", { mb: DOCUMENT_MAX_BYTES / (1024 * 1024) })}
      </p>
      <button type="submit" className={buttonClass} data-testid="upload">
        {t("documents.upload.submit")}
      </button>
    </form>
  );
}

/**
 * A notice's documents on an activity's or event's page: links for those
 * invited; for those who manage it, to whom they are shown, detaching and
 * picking from the viewer's documents, and uploading.
 */
export async function NoticeAttachments({
  kind,
  noticeId,
  clubId,
  attachments,
  candidates,
}: {
  kind: "activities" | "events";
  noticeId: string;
  clubId: string;
  attachments: NoticeAttachmentList | null;
  /** Documents the manager may pick (their newest readable ones in the club). */
  candidates: readonly { id: string; name: string }[];
}) {
  if (!attachments || (attachments.items.length === 0 && !attachments.canManage)) return null;
  const t = await getTranslations();
  const attachedIds = new Set(attachments.items.map((a) => a.document.id));
  const shownTo = attachments.shownTo;
  return (
    <section
      aria-labelledby="notice-documents"
      className="space-y-3"
      data-testid="notice-documents"
    >
      <h2 id="notice-documents" className="text-lg font-semibold">
        {t("documents.notice.title")}
      </h2>
      {attachments.items.length > 0 ? (
        <FileList
          clubId={clubId}
          documents={attachments.items.map((a) => a.document)}
          testId="notice-document-list"
        />
      ) : (
        <p className="text-sm text-muted">{t("documents.notice.none")}</p>
      )}
      {attachments.canManage && shownTo ? (
        <>
          <p className="text-sm text-muted" data-testid="notice-shown-to">
            {shownTo.club
              ? t("documents.notice.shownToClub")
              : shownTo.calledUp !== null
                ? t("documents.notice.shownToCalledUp", { count: shownTo.calledUp })
                : t("documents.notice.shownToGroups", {
                    groups: shownTo.groups.map((g) => g.name).join(", "),
                  })}
          </p>
          <ActionForm action="notice-attachments" className="space-y-2">
            <input type="hidden" name="kind" value={kind} />
            <input type="hidden" name="noticeId" value={noticeId} />
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">{t("documents.notice.pick")}</legend>
              {[
                ...attachments.items.map((a) => ({ id: a.document.id, name: a.document.name })),
                ...candidates.filter((c) => !attachedIds.has(c.id)),
              ].map((d) => (
                <label key={d.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="documentId"
                    value={d.id}
                    defaultChecked={attachedIds.has(d.id)}
                  />
                  {d.name}
                </label>
              ))}
            </fieldset>
            <button type="submit" className={secondaryButtonClass} data-testid="save-attachments">
              {t("documents.notice.save")}
            </button>
          </ActionForm>
          <UploadForm
            clubId={clubId}
            target={kind === "activities" ? "activity" : "event"}
            targetId={noticeId}
            newFile
          />
        </>
      ) : null}
    </section>
  );
}

/** A notice's documents section, loading what it needs (the candidates only for those who manage it). */
export async function NoticeDocuments({
  kind,
  noticeId,
  clubId,
}: {
  kind: "activities" | "events";
  noticeId: string;
  clubId: string;
}) {
  const attachments = await getNoticeAttachments(kind, noticeId);
  const candidates = attachments?.canManage
    ? (await getMyDocuments(null)).items
        .filter((item) => item.document.clubId === clubId && item.document.current)
        .map((item) => ({ id: item.document.id, name: item.document.name }))
    : [];
  return (
    <NoticeAttachments
      kind={kind}
      noticeId={noticeId}
      clubId={clubId}
      attachments={attachments}
      candidates={candidates}
    />
  );
}
