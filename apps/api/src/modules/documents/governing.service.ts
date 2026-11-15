// SPDX-License-Identifier: AGPL-3.0-only
// Governing documents (P2.4, ADR 0049 decision 1B; ADR 0037).
//
// - A series is a top-level folder of the purpose `series` (statutes,
//   minutes, policies), of the club or of a group (a board's minutes), so
//   audiences, "Mina dokument" and the archive work unchanged.
// - A governing document is Markdown: its draft is edited in place; once a
//   version is adopted it is locked (the database refuses changes too) and
//   the next edit starts a new draft version.
// - Adopting records the meeting's date, the meeting (an activity or an
//   event), the effective date, and writes the settings the text marks
//   (`{{setting key = value}}`) as the club's board decision pointing at the
//   version, in the same transaction (ClubPrivacyService). It may supersede
//   other adopted documents. Adopted documents are archived, never deleted.
// Who may do what is the controller's: reading follows the series'
// audience (document.read), drafting `club.governing_documents.manage`,
// adopting `club.governing_documents.adopt` with MFA.

import { audit, type Database, type TenantContext, type Tx } from "@clubadmin/db";
import {
  type AdoptGoverningDocumentInput,
  type AudienceInput,
  BOARD_SETTING_KEYS,
  type BoardSettingKey,
  type CreateDocumentSeriesInput,
  type CreateGoverningDocumentInput,
  settingMarkers,
  settingMarkerValue,
  type UpdateGoverningDocumentInput,
  uuidv7,
} from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { actorPersonId } from "../../platform/domain/run.ts";
import type { ClubPrivacyService } from "../privacy/index.ts";
import { createAudience } from "./audiences.ts";
import * as docs from "./documents.repository.ts";
import * as repo from "./governing.repository.ts";

export type { TextVersionRow } from "./governing.repository.ts";

export interface GoverningView {
  document: docs.DocumentRow & { effectiveAudienceId: string | null };
  series: docs.FolderRow;
  /** The version in force, with its text. */
  current: repo.TextVersionRow | null;
  /** The draft, with its text (those who manage only). */
  draft: repo.TextVersionRow | null;
  /** Newest first, without text: every one for managers, the adopted ones for readers. */
  versions: repo.TextVersionRow[];
  supersededBy: { id: string; name: string } | null;
  supersedes: { id: string; name: string }[];
  audience: docs.AudienceEntryRow[];
}

/** A governing document's file name in the archive (its text as Markdown). */
const fileNameOf = (name: string) => `${name.slice(0, 196)}.md`;

export class GoverningService {
  private readonly db: Database;
  private readonly privacy: ClubPrivacyService;

  constructor(db: Database, deps: { privacy: ClubPrivacyService }) {
    this.db = db;
    this.privacy = deps.privacy;
  }

  // --- Series -------------------------------------------------------------------

  /** The series of the club (groupId null) or a group the caller reads, by name. */
  series(
    context: TenantContext,
    input: { groupId: string | null; manage: boolean; cursor?: string | undefined; limit: number },
  ): Promise<{ rows: docs.FolderRow[]; nextCursor: string | null }> {
    const personId = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      const rows = await repo.seriesPage(tx, {
        clubId: context.clubId,
        groupId: input.groupId,
        personId,
        all: input.manage,
        cursor: input.cursor ?? null,
        limit: input.limit + 1,
      });
      const items = rows.slice(0, input.limit);
      return { rows: items, nextCursor: rows.length > input.limit ? items.at(-1)!.id : null };
    });
  }

  /** A series of the club or a group (default audience: the whole club, or the group). */
  async createSeries(context: TenantContext, input: CreateDocumentSeriesInput): Promise<string> {
    const personId = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      const groupId = input.groupId ?? null;
      if (groupId && !(await repo.groupActive(tx, groupId))) throw new DomainError("not_found");
      const entries: AudienceInput =
        input.audience ?? (groupId ? [{ kind: "group", groupId }] : [{ kind: "club" }]);
      const audienceId = await createAudience(tx, context.clubId, entries);
      const id = await docs.insertFolder(tx, {
        clubId: context.clubId,
        groupId,
        parentId: null,
        name: input.name,
        audienceId,
        createdBy: personId,
        seriesKind: input.seriesKind,
      });
      if (!id) throw new DomainError("folder_name_taken");
      await audit.record(tx, {
        action: "document.folder.created",
        resourceType: "document_folder",
        resourceId: id,
      });
      return id;
    });
  }

  // --- Documents ----------------------------------------------------------------

  /**
   * A governing document: the version in force with its text, the draft
   * (managers), the versions and what it superseded. Readers see adopted
   * documents only (a draft is not found).
   */
  document(context: TenantContext, documentId: string, manage: boolean): Promise<GoverningView> {
    return this.db.withTenant(context, async (tx) => {
      const document = await docs.findDocument(tx, documentId);
      if (!document || document.kind !== "governing") throw new DomainError("not_found");
      if (!manage && !document.currentVersionId) throw new DomainError("not_found");
      const series = await docs.findFolder(tx, document.folderId);
      if (!series) throw new DomainError("not_found");
      const all = await repo.textVersions(tx, documentId);
      const versions = manage ? all : all.filter((v) => v.adoptedOn !== null);
      const current = document.currentVersionId
        ? await repo.textVersion(tx, document.currentVersionId)
        : null;
      const latest = all[0];
      const draft =
        manage && latest && latest.adoptedOn === null
          ? await repo.textVersion(tx, latest.id)
          : null;
      const supersededBy =
        document.governingStatus === "superseded" || document.governingStatus === "archived"
          ? await repo.superseder(tx, documentId)
          : null;
      const supersedes = await repo.documentRefs(tx, { supersededBy: documentId });
      const audiences = await docs.audienceEntries(
        tx,
        document.effectiveAudienceId ? [document.effectiveAudienceId] : [],
      );
      return {
        document,
        series,
        current,
        draft,
        versions,
        supersededBy,
        supersedes: supersedes.map((d) => ({ id: d.id, name: d.name })),
        audience: audiences.get(document.effectiveAudienceId ?? "") ?? [],
      };
    });
  }

  /** One version's text (managers: any; readers: adopted ones). */
  version(
    context: TenantContext,
    documentId: string,
    versionId: string,
    manage: boolean,
  ): Promise<repo.TextVersionRow> {
    return this.db.withTenant(context, async (tx) => {
      const document = await docs.findDocument(tx, documentId);
      if (!document || document.kind !== "governing") throw new DomainError("not_found");
      const version = await repo.textVersion(tx, versionId);
      if (!version || version.documentId !== documentId) throw new DomainError("not_found");
      if (!manage && version.adoptedOn === null) throw new DomainError("not_found");
      return version;
    });
  }

  /** A new governing document in a series: a draft with its first version. */
  create(
    context: TenantContext,
    input: CreateGoverningDocumentInput,
  ): Promise<{ id: string; versionId: string }> {
    return this.db.withTenant(context, (tx) => this.createInTx(tx, context, input));
  }

  /** create in the caller's transaction (minutes assembled from a meeting, P2.4 part B). */
  async createInTx(
    tx: Tx,
    context: TenantContext,
    input: CreateGoverningDocumentInput,
  ): Promise<{ id: string; versionId: string }> {
    const personId = actorPersonId(context);
    const series = await docs.lockFolder(tx, input.seriesId);
    if (!series || series.purpose !== "series") throw new DomainError("series_not_found");
    const id = uuidv7();
    const versionId = uuidv7();
    await repo.insertGoverning(tx, {
      id,
      clubId: context.clubId,
      folderId: series.id,
      groupId: series.groupId,
      name: input.name,
      createdBy: personId,
    });
    await repo.insertTextVersion(tx, {
      id: versionId,
      clubId: context.clubId,
      documentId: id,
      groupId: series.groupId,
      fileName: fileNameOf(input.name),
      body: input.body,
      by: personId,
    });
    await audit.record(tx, {
      action: "document.created",
      resourceType: "document",
      resourceId: id,
    });
    return { id, versionId };
  }

  /**
   * Renames the document and saves the draft's text; when the latest
   * version is adopted, the text starts a new draft version.
   */
  update(
    context: TenantContext,
    documentId: string,
    input: UpdateGoverningDocumentInput,
  ): Promise<{ versionId: string | null }> {
    return this.db.withTenant(context, (tx) => this.updateInTx(tx, context, documentId, input));
  }

  /** update in the caller's transaction (minutes assembled again, P2.4 part B). */
  async updateInTx(
    tx: Tx,
    context: TenantContext,
    documentId: string,
    input: UpdateGoverningDocumentInput,
  ): Promise<{ versionId: string | null }> {
    const personId = actorPersonId(context);
    const document = await this.lockGoverning(tx, documentId);
    if (document.governingStatus === "superseded" || document.governingStatus === "archived") {
      throw new DomainError("document_adopted");
    }
    const changed: string[] = [];
    const name = input.name ?? document.name;
    if (input.name !== undefined && input.name !== document.name) {
      await docs.updateDocument(tx, documentId, { name: input.name });
      changed.push("name");
    }
    let versionId: string | null = null;
    if (input.body !== undefined) {
      const latest = (await repo.textVersions(tx, documentId))[0];
      if (latest && latest.adoptedOn === null) {
        await repo.updateDraftText(tx, {
          versionId: latest.id,
          fileName: fileNameOf(name),
          body: input.body,
          by: personId,
        });
        versionId = latest.id;
      } else {
        versionId = uuidv7();
        await repo.insertTextVersion(tx, {
          id: versionId,
          clubId: context.clubId,
          documentId,
          groupId: document.groupId,
          fileName: fileNameOf(name),
          body: input.body,
          by: personId,
        });
      }
      changed.push("body");
    }
    if (changed.length > 0) {
      await audit.record(tx, {
        action: "document.updated",
        resourceType: "document",
        resourceId: documentId,
        changedFields: changed,
      });
    }
    return { versionId };
  }

  /**
   * Records the draft as adopted: the version is locked and in force, the
   * settings its text marks become a board decision (applied at once when
   * in effect today), and the documents it supersedes are marked so.
   */
  async adopt(
    context: TenantContext,
    documentId: string,
    input: AdoptGoverningDocumentInput,
  ): Promise<void> {
    const personId = actorPersonId(context);
    await this.db.withTenant(context, async (tx) => {
      const document = await this.lockGoverning(tx, documentId);
      if (document.governingStatus === "superseded" || document.governingStatus === "archived") {
        throw new DomainError("document_adopted");
      }
      const latest = (await repo.textVersions(tx, documentId))[0];
      if (!latest || latest.adoptedOn !== null) throw new DomainError("governing_no_draft");
      if (latest.id !== input.versionId) throw new DomainError("governing_draft_changed");
      const today = await this.privacy.clubTodayInTx(tx, context.clubId);
      const effectiveFrom = input.effectiveFrom ?? input.adoptedOn;
      if (input.adoptedOn > today || effectiveFrom < input.adoptedOn) {
        throw new DomainError("governing_dates_invalid");
      }
      const meeting = input.meeting ?? null;
      if (meeting && !(await repo.meetingExists(tx, meeting))) {
        throw new DomainError("governing_meeting_invalid");
      }
      const supersedes = [...new Set(input.supersedes ?? [])];
      const replaced =
        supersedes.length > 0 ? await repo.documentRefs(tx, { ids: supersedes }) : [];
      if (
        supersedes.includes(documentId) ||
        replaced.length !== supersedes.length ||
        replaced.some((d) => d.kind !== "governing" || d.status !== "adopted")
      ) {
        throw new DomainError("governing_supersede_invalid");
      }
      const version = (await repo.textVersion(tx, latest.id))!;
      const settings = this.markedSettings(version.body ?? "");

      await repo.adoptVersion(tx, {
        versionId: latest.id,
        adoptedOn: input.adoptedOn,
        effectiveFrom,
        activityId: meeting?.kind === "activity" ? meeting.id : null,
        eventId: meeting?.kind === "event" ? meeting.id : null,
        by: personId,
      });
      await repo.setGoverning(tx, documentId, { status: "adopted", currentVersionId: latest.id });
      if (Object.keys(settings).length > 0) {
        if (!input.decisionBody) throw new DomainError("governing_decision_body_required");
        try {
          await this.privacy.recordDecisionInTx(
            tx,
            context,
            {
              body: input.decisionBody,
              decidedOn: input.adoptedOn,
              reference: input.reference ?? `${document.name.slice(0, 180)}, v${latest.number}`,
              effectiveFrom,
              settings,
            },
            latest.id,
          );
        } catch (error) {
          if (error instanceof DomainError && error.code === "decision_invalid") {
            throw new DomainError("governing_setting_invalid");
          }
          throw error;
        }
      }
      await audit.record(tx, {
        action: "document.adopted",
        resourceType: "document",
        resourceId: documentId,
      });
      for (const old of replaced) {
        await repo.setGoverning(tx, old.id, { status: "superseded", supersededBy: documentId });
        await audit.record(tx, {
          action: "document.superseded",
          resourceType: "document",
          resourceId: old.id,
        });
      }
    });
  }

  /** Archives a governing document (kept and readable, no longer in force). */
  async archive(context: TenantContext, documentId: string): Promise<void> {
    await this.db.withTenant(context, async (tx) => {
      const document = await this.lockGoverning(tx, documentId);
      if (document.governingStatus === "archived") return;
      if (document.governingStatus === "draft") throw new DomainError("governing_no_draft");
      await repo.setGoverning(tx, documentId, { status: "archived" });
      await audit.record(tx, {
        action: "document.archived",
        resourceType: "document",
        resourceId: documentId,
      });
    });
  }

  /** Deletes a draft never adopted (adopted documents are archived instead). */
  async delete(context: TenantContext, documentId: string): Promise<void> {
    const personId = actorPersonId(context);
    await this.db.withTenant(context, async (tx) => {
      const document = await this.lockGoverning(tx, documentId);
      if (document.governingStatus !== "draft") throw new DomainError("document_adopted");
      await docs.deleteDocument(tx, documentId, personId);
      await audit.record(tx, {
        action: "document.deleted",
        resourceType: "document",
        resourceId: documentId,
      });
    });
  }

  private async lockGoverning(
    tx: Tx,
    documentId: string,
  ): Promise<NonNullable<Awaited<ReturnType<typeof docs.lockDocument>>>> {
    const document = await docs.lockDocument(tx, documentId);
    if (!document || document.kind !== "governing") throw new DomainError("not_found");
    return document;
  }

  /**
   * The settings the text marks, by key (`governing_setting_invalid` for a
   * key that is not a board setting, a value that cannot be read, or one
   * key marked with two values). The values' limits are checked when the
   * decision is recorded.
   */
  private markedSettings(body: string): Record<string, unknown> {
    const settings: Record<string, unknown> = {};
    for (const marker of settingMarkers(body)) {
      if (!(BOARD_SETTING_KEYS as readonly string[]).includes(marker.key)) {
        throw new DomainError("governing_setting_invalid");
      }
      const value = settingMarkerValue(marker.key as BoardSettingKey, marker.value);
      if (value === undefined) throw new DomainError("governing_setting_invalid");
      if (
        Object.hasOwn(settings, marker.key) &&
        JSON.stringify(settings[marker.key]) !== JSON.stringify(value)
      ) {
        throw new DomainError("governing_setting_invalid");
      }
      settings[marker.key] = value;
    }
    return settings;
  }
}
