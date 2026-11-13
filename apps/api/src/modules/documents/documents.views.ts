// SPDX-License-Identifier: AGPL-3.0-only
// The file archive's rows as API output (P2.2). Uploaders go through the
// PersonPresenter (ADR 0022): hidden people are left out (null).

import type { DocumentSummary, DocumentVersion, PersonSummary } from "@clubadmin/shared";

import type {
  PersonPresenter} from "../authorization/index.ts";
import {
  type RequestAuthorization,
  tenantContext,
} from "../authorization/index.ts";
import type { PeopleService } from "../people/index.ts";
import type { DocumentRow, VersionRow } from "./documents.service.ts";

export const iso = (d: Date) => d.toISOString();

export type Uploaders = Map<string, PersonSummary>;

/** The uploaders of these versions the caller may see. */
export async function loadUploaders(
  people: PeopleService,
  presenter: PersonPresenter,
  authz: RequestAuthorization,
  clubId: string,
  versions: readonly (VersionRow | null)[],
): Promise<Uploaders> {
  const ids = [
    ...new Set(versions.flatMap((v) => (v?.uploadedByPersonId ? [v.uploadedByPersonId] : []))),
  ];
  if (ids.length === 0) return new Map();
  const rows = await people.summaries(tenantContext(authz, clubId), ids);
  return new Map((await presenter.present(authz, clubId, rows)).map((p) => [p.id, p]));
}

export function toVersion(v: VersionRow, uploaders: Uploaders): DocumentVersion {
  return {
    id: v.id,
    number: v.number,
    fileName: v.fileName,
    size: v.size,
    contentType: v.contentType,
    status: v.status,
    sha256: v.sha256,
    uploadedBy: (v.uploadedByPersonId && uploaders.get(v.uploadedByPersonId)) || null,
    uploadedAt: v.uploadedAt ? iso(v.uploadedAt) : null,
    createdAt: iso(v.createdAt),
  };
}

export function toDocument(d: DocumentRow, uploaders: Uploaders): DocumentSummary {
  return {
    id: d.id,
    clubId: d.clubId,
    folderId: d.folderId,
    kind: d.kind,
    name: d.name,
    current: d.current ? toVersion(d.current, uploaders) : null,
    latest: d.latest ? toVersion(d.latest, uploaders) : null,
    ownAudience: d.audienceId !== null,
    updatedAt: iso(d.updatedAt),
    publishedAt: d.publishedAt ? iso(d.publishedAt) : null,
    deleteAfter: d.deleteAfter,
  };
}
