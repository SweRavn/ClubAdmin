// SPDX-License-Identifier: AGPL-3.0-only
// The file archive (P2.2, ADR 0049; migration 0042): audiences and their
// entries (shared with announcements), folders at club or group level,
// documents and every version of them. The migration holds the partial and
// expression indexes, the functions (app.audience_includes, ...) and RLS.

import type {
  AudienceEntryKind,
  DocumentKind,
  DocumentVersionStatus,
  FolderPurpose,
} from "@clubadmin/shared";
import {
  type AnyPgColumn,
  bigint,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { clubRef } from "./clubs.ts";
import { id, timestamps, tz } from "./columns.ts";
import { groups } from "./groups.ts";
import { people } from "./people.ts";

export const audiences = pgTable(
  "audiences",
  { id: id(), clubId: clubRef(), ...timestamps },
  (t) => [unique("audiences_club_id_unique").on(t.clubId, t.id)],
);

export const audienceEntries = pgTable(
  "audience_entries",
  {
    id: id(),
    clubId: clubRef(),
    audienceId: uuid().notNull(),
    kind: text().$type<AudienceEntryKind>().notNull(),
    groupId: uuid(),
    roleIds: uuid().array(),
    roleId: uuid(),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "audience_entries_audience_fk",
      columns: [t.clubId, t.audienceId],
      foreignColumns: [audiences.clubId, audiences.id],
    }),
    index("audience_entries_audience_idx").on(t.audienceId),
  ],
);

export const documentFolders = pgTable(
  "document_folders",
  {
    id: id(),
    clubId: clubRef(),
    groupId: uuid(),
    parentId: uuid().references((): AnyPgColumn => documentFolders.id),
    name: text().notNull(),
    audienceId: uuid(),
    purpose: text().$type<FolderPurpose>().notNull().default("files"),
    createdByPersonId: uuid().references(() => people.id),
    deletedAt: timestamp(tz),
    deletedByPersonId: uuid().references(() => people.id),
    ...timestamps,
  },
  (t) => [
    unique("document_folders_club_id_unique").on(t.clubId, t.id),
    foreignKey({
      name: "document_folders_group_fk",
      columns: [t.clubId, t.groupId],
      foreignColumns: [groups.clubId, groups.id],
    }),
  ],
);

export const documents = pgTable(
  "documents",
  {
    id: id(),
    clubId: clubRef(),
    folderId: uuid().notNull(),
    groupId: uuid(),
    kind: text().$type<DocumentKind>().notNull().default("file"),
    name: text().notNull(),
    audienceId: uuid(),
    currentVersionId: uuid(),
    createdByPersonId: uuid().references(() => people.id),
    deletedAt: timestamp(tz),
    deletedByPersonId: uuid().references(() => people.id),
    ...timestamps,
  },
  (t) => [
    unique("documents_club_id_unique").on(t.clubId, t.id),
    foreignKey({
      name: "documents_folder_fk",
      columns: [t.clubId, t.folderId],
      foreignColumns: [documentFolders.clubId, documentFolders.id],
    }),
  ],
);

export const documentVersions = pgTable(
  "document_versions",
  {
    id: id(),
    clubId: clubRef(),
    documentId: uuid().notNull(),
    groupId: uuid(),
    number: integer().notNull(),
    objectKey: text().notNull(),
    fileName: text().notNull(),
    size: bigint({ mode: "number" }).notNull(),
    contentType: text().notNull(),
    sha256: text(),
    status: text().$type<DocumentVersionStatus>().notNull().default("uploading"),
    uploadedByPersonId: uuid().references(() => people.id),
    uploadedAt: timestamp(tz),
    scannedAt: timestamp(tz),
    objectDeletedAt: timestamp(tz),
    ...timestamps,
  },
  (t) => [
    unique("document_versions_club_id_unique").on(t.clubId, t.id),
    unique("document_versions_number_unique").on(t.documentId, t.number),
    unique("document_versions_object_key_unique").on(t.objectKey),
    foreignKey({
      name: "document_versions_document_fk",
      columns: [t.clubId, t.documentId],
      foreignColumns: [documents.clubId, documents.id],
    }),
  ],
);
