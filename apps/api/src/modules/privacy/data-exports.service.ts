// SPDX-License-Identifier: AGPL-3.0-only
// "Download my data" (P1.8b, ADR 0041): a person requests a file of
// everything about themselves or a ward they are a full guardian of; the
// insert trigger queues privacy:export (data-export.job.ts), which writes
// the ZIP. Only the requester downloads it, through a five-minute link,
// while the file exists (seven days). At most three requests a day.

import { type ActorContext, audit, type Database } from "@clubadmin/db";
import type { ObjectStorage } from "@clubadmin/server-kit/object-storage";
import { DATA_EXPORTS_PER_DAY } from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import * as repo from "./data-rights.repository.ts";

/** Pre-signed download links are valid this long. */
const DOWNLOAD_SECONDS = 300;

const requesterOf = (context: ActorContext): string => {
  if (!context.personId) throw new DomainError("not_allowed");
  return context.personId;
};

export class DataExportsService {
  private readonly db: Database;
  private readonly storage: ObjectStorage | null;

  constructor(db: Database, deps: { storage: ObjectStorage | null }) {
    this.db = db;
    this.storage = deps.storage;
  }

  /**
   * Requests an export for the subject (the caller or their ward; the
   * controller checks the guardianship, row-level security again). The file
   * is written in the requester's language, or `fallbackLocale`.
   */
  request(
    context: ActorContext,
    subjectId: string,
    fallbackLocale: string,
  ): Promise<repo.DataExportRow> {
    return this.db.withActor(context, async (tx) => {
      const requester = requesterOf(context);
      if ((await repo.countRecentExports(tx, requester)) >= DATA_EXPORTS_PER_DAY) {
        throw new DomainError("export_limit_reached");
      }
      const locale = (await repo.accountLocale(tx, requester)) ?? fallbackLocale;
      const row = await repo.insertExport(tx, {
        subjectPersonId: subjectId,
        requestedByPersonId: requester,
        locale,
      });
      await audit.record(tx, {
        action: "privacy.export.requested",
        resourceType: "data_export",
        resourceId: row.id,
      });
      return row;
    });
  }

  /** The caller's requests, newest first. */
  list(
    context: ActorContext,
    options: { after: string | null; limit: number },
  ): Promise<repo.DataExportRow[]> {
    return this.db.withActor(context, async (tx) => {
      const requester = requesterOf(context);
      if (options.after && !(await repo.exportExists(tx, options.after, requester))) {
        throw new DomainError("invalid_cursor");
      }
      return repo.listExports(tx, requester, options);
    });
  }

  /** A five-minute download link for the requester, while the file exists. */
  download(context: ActorContext, exportId: string): Promise<{ url: string; expiresAt: Date }> {
    return this.db.withActor(context, async (tx) => {
      const row = await repo.findExport(tx, exportId);
      if (!row || row.requestedByPersonId !== requesterOf(context)) {
        throw new DomainError("not_found");
      }
      if (
        row.status !== "ready" ||
        !row.objectKey ||
        !row.expiresAt ||
        row.expiresAt <= new Date()
      ) {
        throw new DomainError("export_expired");
      }
      if (!this.storage) throw new DomainError("export_storage_unavailable");
      await audit.record(tx, {
        action: "privacy.export.downloaded",
        resourceType: "data_export",
        resourceId: row.id,
      });
      const date = row.createdAt.toISOString().slice(0, 10);
      return {
        url: this.storage.presignDownload(row.objectKey, {
          expiresSeconds: DOWNLOAD_SECONDS,
          filename: `clubadmin-data-${date}.zip`,
        }),
        expiresAt: new Date(Date.now() + DOWNLOAD_SECONDS * 1000),
      };
    });
  }
}
