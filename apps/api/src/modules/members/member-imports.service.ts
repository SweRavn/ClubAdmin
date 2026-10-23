// SPDX-License-Identifier: AGPL-3.0-only
// Member imports (P1.3b, ADR 0033): the registrar uploads a CSV file through
// a pre-signed link; the members:import_parse job reads it (then deletes it),
// keeps its cells sealed in staging rows and validates them against the
// mapping; the registrar fixes the mapping, skips rows and resolves possible
// duplicates (within the club only); after confirmation the
// members:import_run job adds the members in batches of 100 through the
// member intake (each batch one transaction, each row all or nothing).
// Logs and audit events carry IDs and counts, never row contents.

import { getCountryPack } from "@clubadmin/country-packs";
import {
  audit,
  type Database,
  outbox,
  savepoint,
  type schema,
  type TenantContext,
  type Tx,
} from "@clubadmin/db";
import type { Logger } from "@clubadmin/server-kit";
import type { ObjectStorage } from "@clubadmin/server-kit/object-storage";
import {
  type CreateMemberImportInput,
  CreateMemberImportSchema,
  EMPTY_IMPORT_COUNTS,
  isLinkedGuardianshipKind,
  MEMBER_IMPORT_MAX_BYTES,
  MEMBER_IMPORT_MAX_ROWS,
  type MemberImportCounts,
  type MemberImportIssue,
  type MemberImportOptions,
  MemberImportOptionsSchema,
  type MemberImportResolution,
  type MemberImportRowStatus,
  type UpdateMemberImportMappingInput,
  UpdateMemberImportMappingSchema,
  type UpdateMemberImportRowInput,
  UpdateMemberImportRowSchema,
  uuidv7,
} from "@clubadmin/shared";

import type { FieldEncryption } from "../../platform/crypto/field-encryption.ts";
import { DomainError, isDomainError } from "../../platform/domain/domain-error.ts";
import { actorPersonId, parseInput } from "../../platform/domain/run.ts";
import type { ClubProfilesService } from "../club-profiles/index.ts";
import type { ClubsService } from "../clubs/index.ts";
import type { GroupsService } from "../groups/index.ts";
import type { PeopleService } from "../people/index.ts";
import { CsvError, decodeCsv, parseCsv } from "./import/csv.ts";
import { suggestMapping } from "./import/headers.ts";
import { columnsOf, hasErrors, type MappedRow, mappingComplete, mapRow } from "./import/rows.ts";
import * as repo from "./member-imports.repository.ts";
import type { IntakeGuardian, IntakeMember, MemberIntakeService } from "./member-intake.service.ts";
import * as membersRepo from "./members.repository.ts";

export type MemberImport = repo.MemberImportRow;
export type MemberImportStagingRow = repo.ImportRowRow;
type RowData = schema.MemberImportRowData;

export interface MemberImportsOptions {
  importsPerClubPerDay: number;
  invitationsPerClubPerDay: number;
  /** Batches imported at the same time (database connections used by one import). */
  batchConcurrency?: number;
}

/** What one batch of the run job shares and keeps. */
interface BatchState {
  /** Guardians created by earlier runs of this import (a retried job). */
  known: ReadonlyMap<string, string>;
  /** Guardians this batch created (key → person). */
  created: Map<string, string>;
  /** Invitations the club may still send today (shared by the batches). */
  invitations: { left: number };
  /** Invitations this attempt used (given back if it is rolled back). */
  used: number;
}

/**
 * Batches of about `size` rows in file order, keeping the rows that share a
 * new guardian (by name and phone, or email) in one batch: batches then run
 * concurrently without creating the same guardian twice.
 */
export function importBatches<T extends { data: unknown }>(
  rows: readonly T[],
  size: number,
): T[][] {
  const parent = rows.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  const owner = new Map<string, number>();
  rows.forEach((row, i) => {
    for (const g of (row.data as RowData).guardians) {
      if (g.personId) continue;
      for (const key of [guardianKey(g, false), g.email ? `e:${g.email}` : null]) {
        if (!key) continue;
        const other = owner.get(key);
        if (other === undefined) owner.set(key, i);
        else parent[find(i)] = find(other);
      }
    }
  });
  const families = new Map<number, T[]>();
  rows.forEach((row, i) => {
    const root = find(i);
    const family = families.get(root);
    if (family) family.push(row);
    else families.set(root, [row]);
  });
  const batches: T[][] = [];
  let current: T[] = [];
  for (const family of families.values()) {
    current.push(...family);
    if (current.length >= size) {
      batches.push(current);
      current = [];
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Rows written per transaction (docs/performance.md). */
export const IMPORT_BATCH_SIZE = 100;
/** Pre-signed upload links are valid this long. */
const UPLOAD_SECONDS = 15 * 60;

const cellsAad = (importId: string, rowNumber: number) =>
  `member_import_rows.cells:${importId}:${rowNumber}`;
const pinAad = (rowId: string) => `member_import_rows.personal_identity_number:${rowId}`;

/** Today's date in a time zone (ISO). */
const todayIn = (timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());

/** A guardian's identity within one import (the same parent of several children is one person). */
const guardianKey = (g: RowData["guardians"][number], invited: boolean): string =>
  g.personId
    ? `p:${g.personId}`
    : invited && g.email
      ? `e:${g.email}`
      : `n:${(g.given ?? "").toLowerCase()}|${(g.family ?? "").toLowerCase()}|${(g.phone ?? "").replace(/[^0-9]/g, "")}`;

/** The status of a validated row from its issues and the registrar's choices. */
export function rowStatus(row: {
  issues: readonly string[];
  skippedByUser: boolean;
  resolution: MemberImportResolution | null;
}): MemberImportRowStatus {
  if (hasErrors(row.issues)) return "error";
  if (row.skippedByUser) return "skipped";
  if (row.issues.includes("already_in_club") && row.resolution === null) return "skipped";
  if (row.issues.includes("possible_duplicate") && row.resolution === null) return "duplicate";
  return "new";
}

export class MemberImportsService {
  private readonly db: Database;
  private readonly storage: ObjectStorage | null;
  private readonly encryption: FieldEncryption;
  private readonly intake: MemberIntakeService;
  private readonly people: PeopleService;
  private readonly clubs: ClubsService;
  private readonly groups: GroupsService;
  private readonly profiles: ClubProfilesService;
  private readonly options: MemberImportsOptions;
  private readonly logger: Logger | undefined;

  constructor(
    db: Database,
    deps: {
      storage: ObjectStorage | null;
      encryption: FieldEncryption;
      intake: MemberIntakeService;
      people: PeopleService;
      clubs: ClubsService;
      groups: GroupsService;
      profiles: ClubProfilesService;
      logger?: Logger;
    },
    options: MemberImportsOptions,
  ) {
    this.db = db;
    this.storage = deps.storage;
    this.encryption = deps.encryption;
    this.intake = deps.intake;
    this.people = deps.people;
    this.clubs = deps.clubs;
    this.groups = deps.groups;
    this.profiles = deps.profiles;
    this.options = options;
    this.logger = deps.logger;
  }

  /** Starts an import: the record and a pre-signed upload link (PUT, 15 minutes). */
  start(
    context: TenantContext,
    input: CreateMemberImportInput,
  ): Promise<{ import: MemberImport; uploadUrl: string; uploadExpiresAt: Date }> {
    return this.db.withTenant(context, async (tx) => {
      const data = parseInput(CreateMemberImportSchema, input);
      const personId = actorPersonId(context);
      // XLSX: no parser on the licence allow list that never evaluates formulas (ADR 0033).
      if (data.format !== "csv") throw new DomainError("import_format_unsupported");
      const storage = this.storage;
      if (!storage || !this.encryption.available)
        throw new DomainError("import_storage_unavailable");
      if ((await repo.recentImportCount(tx, context.clubId)) >= this.options.importsPerClubPerDay)
        throw new DomainError("import_limit_reached");
      const id = uuidv7();
      const objectKey = `imports/${context.clubId}/${id}`;
      const row = await repo.insertImport(tx, {
        id,
        clubId: context.clubId,
        createdByPersonId: personId,
        sourceFormat: data.format,
        options: MemberImportOptionsSchema.parse({}),
        objectKey,
      });
      await audit.record(tx, {
        action: "members.import.started",
        resourceType: "member_import",
        resourceId: id,
      });
      return {
        import: row,
        uploadUrl: storage.presignUpload(objectKey, {
          expiresSeconds: UPLOAD_SECONDS,
          size: data.size,
          contentType: "text/csv",
        }),
        uploadExpiresAt: new Date(Date.now() + UPLOAD_SECONDS * 1000),
      };
    });
  }

  /** The file is uploaded: the parse job reads it (the status change queues it). */
  uploaded(context: TenantContext, importId: string): Promise<MemberImport> {
    return this.db.withTenant(context, async (tx) => {
      const row = await repo.lockImport(tx, importId);
      if (!row) throw new DomainError("not_found");
      if (row.status !== "uploaded") throw new DomainError("import_not_uploaded");
      await repo.updateImport(tx, importId, { status: "parsing" });
      return { ...row, status: "parsing" };
    });
  }

  get(context: TenantContext, importId: string): Promise<MemberImport> {
    return this.db.withTenant(context, async (tx) => {
      const row = await repo.findImport(tx, importId);
      if (!row) throw new DomainError("not_found");
      return row;
    });
  }

  list(
    context: TenantContext,
    page: { cursor?: string | undefined; limit: number },
  ): Promise<{ items: MemberImport[]; nextCursor: string | null }> {
    return this.db.withTenant(context, async (tx) => {
      const rows = await repo.listImports(tx, context.clubId, {
        cursor: page.cursor ?? null,
        limit: page.limit + 1,
      });
      const items = rows.slice(0, page.limit);
      return { items, nextCursor: rows.length > page.limit ? items.at(-1)!.id : null };
    });
  }

  /** A new mapping and options: the rows are validated again (parse job, without the file). */
  updateMapping(
    context: TenantContext,
    importId: string,
    input: UpdateMemberImportMappingInput,
  ): Promise<MemberImport> {
    return this.db.withTenant(context, async (tx) => {
      const data = parseInput(UpdateMemberImportMappingSchema, input);
      const row = await repo.lockImport(tx, importId);
      if (!row) throw new DomainError("not_found");
      if (row.status !== "review") throw new DomainError("import_not_in_review");
      if (!mappingComplete(data.columnMap)) throw new DomainError("import_mapping_incomplete");
      await repo.updateImport(tx, importId, {
        columnMap: data.columnMap,
        options: data.options,
        status: "parsing",
      });
      return { ...row, columnMap: data.columnMap, options: data.options, status: "parsing" };
    });
  }

  /** A page of preview rows (keyset by row number), optionally of one status. */
  rows(
    context: TenantContext,
    importId: string,
    page: {
      status?: MemberImportRowStatus | undefined;
      cursor?: number | undefined;
      limit: number;
    },
  ): Promise<{ items: MemberImportStagingRow[]; nextCursor: number | null }> {
    return this.db.withTenant(context, async (tx) => {
      const row = await repo.findImport(tx, importId);
      if (!row) throw new DomainError("not_found");
      const rows = await repo.rowsPage(tx, importId, {
        status: page.status,
        after: page.cursor ?? 0,
        limit: page.limit + 1,
      });
      const items = rows.slice(0, page.limit);
      return {
        items,
        nextCursor: rows.length > page.limit ? items.at(-1)!.rowNumber : null,
      };
    });
  }

  /** Skip or un-skip a row; "same person" or "different person" for a matched one. */
  updateRow(
    context: TenantContext,
    importId: string,
    rowNumber: number,
    input: UpdateMemberImportRowInput,
  ): Promise<MemberImportStagingRow> {
    return this.db.withTenant(context, async (tx) => {
      const { action } = parseInput(UpdateMemberImportRowSchema, input);
      const imp = await repo.lockImport(tx, importId);
      if (!imp) throw new DomainError("not_found");
      if (imp.status !== "review") throw new DomainError("import_not_in_review");
      const row = await repo.findRow(tx, importId, rowNumber);
      if (!row) throw new DomainError("not_found");
      let resolution = row.resolution;
      if ((action === "same_person" || action === "different_person") && !row.matchPersonId)
        throw new DomainError("invalid_input");
      if (action === "same_person" || action === "different_person") resolution = action;
      // Deciding about a match includes the row again.
      const skippedByUser = action === "skip";
      const status = rowStatus({ issues: row.issues, skippedByUser, resolution });
      await repo.updateRow(tx, row.id, { skippedByUser, resolution, status });
      await this.refreshCountsInTx(tx, imp);
      return { ...row, skippedByUser, resolution, status };
    });
  }

  /** Confirmation (recent login, the controller): the run job adds the members. */
  confirm(context: TenantContext, importId: string): Promise<MemberImport> {
    return this.db.withTenant(context, async (tx) => {
      const row = await repo.lockImport(tx, importId);
      if (!row) throw new DomainError("not_found");
      if (row.status !== "review") throw new DomainError("import_not_in_review");
      const confirmedAt = new Date();
      const values = {
        status: "importing" as const,
        confirmedByPersonId: actorPersonId(context),
        confirmedAt,
      };
      await repo.updateImport(tx, importId, values);
      await audit.record(tx, {
        action: "members.import.confirmed",
        resourceType: "member_import",
        resourceId: importId,
        changedFields: row.options.sendInvitations ? ["send_invitations"] : [],
      });
      return { ...row, ...values };
    });
  }

  /** Cancels before confirmation; the uploaded file is deleted. */
  async cancel(context: TenantContext, importId: string): Promise<MemberImport> {
    const result = await this.db.withTenant(context, async (tx) => {
      const row = await repo.lockImport(tx, importId);
      if (!row) throw new DomainError("not_found");
      if (!["uploaded", "parsing", "review", "failed"].includes(row.status))
        throw new DomainError("import_not_cancellable");
      const values = { status: "cancelled" as const, finishedAt: new Date(), objectKey: null };
      await repo.updateImport(tx, importId, values);
      await audit.record(tx, {
        action: "members.import.cancelled",
        resourceType: "member_import",
        resourceId: importId,
      });
      return { previousKey: row.objectKey, row: { ...row, ...values } };
    });
    if (result.previousKey) await this.deleteFile(result.previousKey);
    return result.row;
  }

  /**
   * An import of a file the caller already has (the demo seed, tests): the
   * same parsing and validation as the parse job, without object storage.
   * Ends in review (or failed with a code).
   */
  async importFile(
    context: TenantContext,
    bytes: Uint8Array,
    setup: {
      options?: Partial<MemberImportOptions>;
      columnMap?: Record<string, string>;
      id?: string;
    } = {},
  ): Promise<MemberImport> {
    const personId = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      const id = setup.id ?? uuidv7();
      const imp = await repo.insertImport(tx, {
        id,
        clubId: context.clubId,
        createdByPersonId: personId,
        status: "parsing",
        options: MemberImportOptionsSchema.parse(setup.options ?? {}),
        columnMap: setup.columnMap ?? {},
      });
      await audit.record(tx, {
        action: "members.import.started",
        resourceType: "member_import",
        resourceId: id,
      });
      await this.loadBytesInTx(tx, imp, bytes);
      await this.validateInTx(tx, context, id);
      return (await repo.findImport(tx, id))!;
    });
  }

  // --- Jobs --------------------------------------------------------------------

  /**
   * members:import_parse: reads the uploaded file once (then deletes it) into
   * sealed staging rows, and validates all rows against the mapping. A bad
   * file fails the import with a code; other errors are retried by the queue.
   */
  async parseJob(importId: string, clubId: string): Promise<void> {
    const imp = await this.db.withSystem("members:import_parse", { clubId }, (tx) =>
      repo.findImport(tx, importId),
    );
    if (!imp || imp.status !== "parsing") return;
    const context: TenantContext = {
      actorKind: "person",
      personId: imp.createdByPersonId,
      clubId,
    };
    const started = Date.now();
    let fileKey: string | null = null;
    try {
      await this.db.withTenant(context, async (tx) => {
        if (!(await repo.hasRows(tx, importId))) {
          fileKey = await this.loadFileInTx(tx, imp);
        }
        await this.validateInTx(tx, context, importId);
      });
    } catch (error) {
      const code =
        error instanceof CsvError
          ? error.code
          : isDomainError(error) &&
              ["import_file_missing", "import_file_too_large"].includes(error.code)
            ? error.code
            : null;
      if (!code) throw error;
      await this.db.withTenant(context, async (tx) => {
        await repo.updateImport(tx, importId, {
          status: "failed",
          errorCode: code,
          finishedAt: new Date(),
          objectKey: null,
        });
      });
      if (imp.objectKey) await this.deleteFile(imp.objectKey);
      this.logger?.info({ importId, clubId, errorCode: code }, "member import failed");
      return;
    }
    if (fileKey) await this.deleteFile(fileKey);
    this.logger?.info({ importId, clubId, ms: Date.now() - started }, "member import parsed");
  }

  /**
   * members:import_run: adds the confirmed rows in batches of 100 as the
   * confirming registrar. A failed row is marked (import_failed) and the
   * rest continue; a retried job continues after the imported rows.
   */
  async runJob(
    importId: string,
    clubId: string,
    /** Fixed IDs of the people created (the demo seed): by row number, guardian index. */
    ids?: (rowNumber: number, guardian: number | null) => string,
  ): Promise<void> {
    const imp = await this.db.withSystem("members:import_run", { clubId }, (tx) =>
      repo.findImport(tx, importId),
    );
    if (!imp || imp.status !== "importing" || !imp.confirmedByPersonId) return;
    const context: TenantContext = {
      actorKind: "person",
      personId: imp.confirmedByPersonId,
      clubId,
    };
    const options = MemberImportOptionsSchema.parse(imp.options);
    const started = Date.now();
    const { known, invitations, rows } = await this.db.withTenant(context, async (tx) => ({
      // Guardians created by this import so far (a retried job keeps them).
      known: await this.createdGuardiansInTx(tx, importId),
      invitations: {
        left: Math.max(
          0,
          this.options.invitationsPerClubPerDay -
            (await repo.recentClubInvitationCount(tx, clubId)),
        ),
      },
      rows: (await repo.rowsToImport(tx, importId, 0, MEMBER_IMPORT_MAX_ROWS + 1)).filter(
        (r) => r.data && !r.data.relation,
      ),
    }));

    const runBatch = async (batch: readonly MemberImportStagingRow[]) => {
      // Running numbers for the new people, reserved outside the batch so
      // concurrent batches never wait for each other on the club's counter.
      const numbered = batch.filter(
        (r) =>
          r.resolution !== "same_person" &&
          !(options.memberNumbers === "keep" && (r.data as RowData).memberNumber),
      );
      const first =
        numbered.length > 0
          ? await this.profiles.reserveMemberNumbers(context, numbered.length)
          : 0;
      const numbers = new Map(numbered.map((r, i) => [r.id, first + i]));
      // Fast path: the batch in one transaction without savepoints. If a row
      // fails, the batch is rolled back and done again row by row, each row
      // under a savepoint, so the failed rows are marked and the rest are kept.
      const attempt = (careful: boolean) => {
        const state: BatchState = { known, created: new Map(), invitations, used: 0 };
        return this.db
          .withTenant(context, async (tx) => {
            if (!(await membersRepo.actorHasClubRole(tx, ["club_manager", "registrar"])))
              throw new DomainError("not_allowed");
            const done: repo.ImportedRow[] = [];
            for (const row of batch) {
              const data = structuredClone(row.data as RowData);
              const number = numbers.get(row.id) ?? null;
              const one = () => this.importRowInTx(tx, context, imp, row, data, state, number, ids);
              if (!careful) {
                done.push(await one());
                continue;
              }
              try {
                done.push(await savepoint(tx, one));
              } catch (error) {
                if (!isDomainError(error)) throw error;
                await repo.updateRow(tx, row.id, {
                  status: "error",
                  issues: [...row.issues, "import_failed"],
                });
              }
            }
            await repo.markRowsImported(tx, done);
          })
          .catch((error: unknown) => {
            // Nothing of the attempt was kept: its invitations are not sent.
            invitations.left += state.used;
            throw error;
          });
      };
      try {
        try {
          await attempt(false);
        } catch (error) {
          if (!isDomainError(error) || isDomainError(error, "not_allowed")) throw error;
          await attempt(true);
        }
      } catch (error) {
        if (isDomainError(error, "not_allowed")) throw error;
        this.logger?.warn({ importId, clubId, err: error }, "member import batch failed");
        await this.db.withTenant(context, async (tx) => {
          for (const row of batch) {
            await repo.updateRow(tx, row.id, {
              status: "error",
              issues: [...row.issues, "import_failed"],
            });
          }
        });
      }
    };

    try {
      const batches = importBatches(rows, IMPORT_BATCH_SIZE);
      let next = 0;
      const lane = async () => {
        while (next < batches.length) await runBatch(batches[next++]!);
      };
      await Promise.all(
        Array.from({ length: Math.min(this.options.batchConcurrency ?? 1, batches.length) }, lane),
      );
    } catch (error) {
      if (!isDomainError(error, "not_allowed")) throw error;
      await this.finishRun(context, imp, "failed", "not_allowed");
      return;
    }
    await this.finishRun(context, imp, "done", null);
    this.logger?.info({ importId, clubId, ms: Date.now() - started }, "member import finished");
  }

  // --- Internals -------------------------------------------------------------

  private async deleteFile(key: string): Promise<void> {
    try {
      await this.storage?.deleteObject(key);
    } catch (error) {
      // The bucket's lifecycle rule deletes it after two days.
      this.logger?.warn({ err: error }, "could not delete an import file");
    }
  }

  /** Reads and seals the file's rows; returns the object key to delete after commit. */
  private async loadFileInTx(tx: Tx, imp: MemberImport): Promise<string> {
    const key = imp.objectKey;
    if (!key || !this.storage) throw new DomainError("import_file_missing");
    let bytes: Buffer | null;
    try {
      bytes = await this.storage.getObject(key, { maxBytes: MEMBER_IMPORT_MAX_BYTES });
    } catch (error) {
      if (error instanceof Error && "status" in error && error.status === 413)
        throw new DomainError("import_file_too_large");
      throw error;
    }
    if (!bytes) throw new DomainError("import_file_missing");
    await this.loadBytesInTx(tx, imp, bytes);
    return key;
  }

  private async loadBytesInTx(tx: Tx, imp: MemberImport, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength > MEMBER_IMPORT_MAX_BYTES) throw new DomainError("import_file_too_large");
    const rows = parseCsv(decodeCsv(bytes), { maxRows: MEMBER_IMPORT_MAX_ROWS });
    const [headers, ...body] = rows as [string[], ...string[][]];
    const club = await this.clubs.getClubInTx(tx, imp.clubId);
    const suggested = suggestMapping(headers, club.country);
    const columns = headers.map((header, index) => ({
      index,
      header: header.slice(0, 100),
      sample:
        (body.slice(0, 20).find((r) => (r[index] ?? "") !== "")?.[index] ?? "").slice(0, 60) ||
        null,
      suggested: suggested.suggestions[index] ?? null,
    }));
    const sealed = await this.encryption.encryptMany(
      tx,
      imp.clubId,
      body.map((cells, i) => ({ plaintext: JSON.stringify(cells), aad: cellsAad(imp.id, i + 1) })),
    );
    await repo.insertRows(
      tx,
      sealed.map((cells, i) => ({
        importId: imp.id,
        clubId: imp.clubId,
        rowNumber: i + 1,
        cells,
      })),
    );
    await repo.updateImport(tx, imp.id, {
      columns,
      columnMap: Object.keys(imp.columnMap).length > 0 ? imp.columnMap : suggested.columnMap,
      detectedSource: suggested.detectedSource,
      objectKey: null,
    });
  }

  /** Maps and checks every row (in the file, then against the club), then counts. */
  private async validateInTx(tx: Tx, context: TenantContext, importId: string): Promise<void> {
    const imp = (await repo.findImport(tx, importId))!;
    const club = await this.clubs.getClubInTx(tx, imp.clubId);
    const pack = getCountryPack(club.country);
    const options = MemberImportOptionsSchema.parse(imp.options);
    const rules = {
      country: club.country,
      dateOrder: pack.memberImport.dateOrder,
      adultAge: pack.ageRules.adultAge,
      today: todayIn(club.timeZone),
      groups: await this.groups.groupIdsByNameInTx(tx, imp.clubId),
      options,
      parsePin: (value: string) => this.people.parsePersonalIdentityNumber(club.country, value),
    };
    const columns = columnsOf(imp.columnMap);
    const stored = await repo.allRows(tx, importId);
    const mapped: (MappedRow & { row: MemberImportStagingRow })[] = [];
    for (const row of stored) {
      const cells = JSON.parse(
        await this.encryption.decrypt(tx, row.cells, cellsAad(importId, row.rowNumber)),
      ) as string[];
      mapped.push({ ...mapRow(cells, columns, rules), row });
    }

    // One row per guardian: attach them to the members of their family.
    const families = new Map<string, typeof mapped>();
    for (const m of mapped) {
      if (m.familyKey) families.set(m.familyKey, [...(families.get(m.familyKey) ?? []), m]);
    }
    for (const m of mapped) {
      if (!m.data.relation) continue;
      const members = (m.familyKey ? families.get(m.familyKey) : undefined)?.filter(
        (x) => !x.data.relation,
      );
      if (!members || members.length === 0) {
        m.issues.push("family_without_member");
        continue;
      }
      if (hasErrors(m.issues)) continue;
      for (const member of members) {
        member.data.guardians.push({
          given: m.data.given,
          family: m.data.family,
          phone: m.data.phone,
          email: m.data.email,
          kind: m.data.relation,
          personId: null,
        });
        if (isLinkedGuardianshipKind(m.data.relation) && !options.consentNote)
          member.issues.push("guardian_consent_note_missing");
      }
    }

    const members = mapped.filter((m) => !m.data.relation);
    // The same person twice in the file.
    const seen = new Set<string>();
    for (const m of members) {
      if (hasErrors(m.issues)) continue;
      const key =
        m.data.personalIdentityNumberHash ??
        `${m.data.given?.toLowerCase()}|${m.data.family?.toLowerCase()}|${m.data.birthDate}`;
      if (seen.has(key)) m.issues.push("repeated_in_file");
      seen.add(key);
    }

    // Duplicates in the club only: exact (already imported) or possible.
    const candidates = members.flatMap((m, key) =>
      !hasErrors(m.issues) && m.data.given && m.data.family && m.data.birthDate
        ? [
            {
              key,
              pinHash: m.data.personalIdentityNumberHash,
              birthDate: m.data.birthDate,
              given: m.data.given.trim().toLowerCase(),
              family: m.data.family.trim().toLowerCase(),
            },
          ]
        : [],
    );
    const matches = await this.people.clubMatchesInTx(tx, imp.clubId, candidates);
    const matchOf = new Map<number, { personId: string; exact: boolean }>();
    for (const match of matches) {
      const current = matchOf.get(match.key);
      if (!current || (match.exact && !current.exact)) matchOf.set(match.key, match);
    }

    // Member numbers kept from the file.
    if (options.memberNumbers === "keep") {
      const numbers = new Map<number, number>();
      for (const m of members) {
        if (m.data.memberNumber)
          numbers.set(m.data.memberNumber, (numbers.get(m.data.memberNumber) ?? 0) + 1);
      }
      const taken = await this.profiles.takenMemberNumbersInTx(tx, imp.clubId, [...numbers.keys()]);
      members.forEach((m, key) => {
        const n = m.data.memberNumber;
        if (!n) return;
        if ((numbers.get(n) ?? 0) > 1) m.issues.push("member_number_repeated");
        else if (taken.has(n) && !matchOf.get(key)?.exact) m.issues.push("member_number_taken");
      });
    }

    // Guardians who are already in the club (same names and phone).
    const guardianCandidates = members.flatMap((m, key) =>
      m.data.guardians.flatMap((g, index) =>
        g.given && g.family && g.phone
          ? [
              {
                key: key * 1000 + index,
                given: g.given.toLowerCase(),
                family: g.family.toLowerCase(),
                phone: g.phone,
              },
            ]
          : [],
      ),
    );
    for (const found of await this.people.clubPeopleByNameAndPhoneInTx(
      tx,
      imp.clubId,
      guardianCandidates,
    )) {
      const m = members[Math.floor(found.key / 1000)]!;
      const guardian = m.data.guardians[found.key % 1000]!;
      if (guardian.personId) continue;
      guardian.personId = found.personId;
      if (!m.issues.includes("guardian_is_member")) m.issues.push("guardian_is_member");
    }

    // Seal the identity numbers (never stored plain, also in staging).
    const withPin = mapped.filter((m) => m.pin);
    const sealed = await this.encryption.encryptMany(
      tx,
      imp.clubId,
      withPin.map((m) => ({ plaintext: `${club.country}:${m.pin!}`, aad: pinAad(m.row.id) })),
    );
    withPin.forEach((m, i) => {
      m.data.personalIdentityNumber = sealed[i]!;
    });

    const updates: repo.ValidatedRow[] = [];
    members.forEach((m, key) => {
      const match = matchOf.get(key);
      if (match) m.issues.push(match.exact ? "already_in_club" : "possible_duplicate");
      const matchPersonId = match?.personId ?? null;
      const resolution = matchPersonId === m.row.matchPersonId ? m.row.resolution : null;
      updates.push({
        id: m.row.id,
        data: m.data,
        issues: [...new Set(m.issues)] as MemberImportIssue[],
        status: rowStatus({ issues: m.issues, skippedByUser: m.row.skippedByUser, resolution }),
        familyKey: m.familyKey,
        matchPersonId,
        resolution,
      });
    });
    for (const m of mapped) {
      if (!m.data.relation) continue;
      updates.push({
        id: m.row.id,
        data: m.data,
        issues: [...new Set(m.issues)],
        status: rowStatus({
          issues: m.issues,
          skippedByUser: m.row.skippedByUser,
          resolution: null,
        }),
        familyKey: m.familyKey,
        matchPersonId: null,
        resolution: null,
      });
    }
    await repo.updateValidatedRows(tx, updates);
    await repo.updateImport(tx, importId, { status: "review", errorCode: null });
    await this.refreshCountsInTx(tx, { ...imp, options });
  }

  /** Counts per status, guardians (one per person) and invitations of the rows to import. */
  private async refreshCountsInTx(tx: Tx, imp: MemberImport): Promise<MemberImportCounts> {
    const rows = await repo.allRows(tx, imp.id);
    const counts: MemberImportCounts = { ...EMPTY_IMPORT_COUNTS, rows: rows.length };
    const guardians = new Set<string>();
    const options = MemberImportOptionsSchema.parse(imp.options);
    for (const row of rows) {
      const data = row.data;
      // A guardian's own row counts only as an error (its guardian is counted on the members).
      if (data?.relation && row.status !== "error") continue;
      counts[row.status]++;
      if (!data || (row.status !== "new" && row.status !== "imported")) continue;
      if (options.sendInvitations && data.email) counts.invitations++;
      for (const g of data.guardians) {
        const invited = options.sendInvitations && g.email !== null && g.personId === null;
        guardians.add(guardianKey(g, invited));
        if (invited) counts.invitations++;
      }
    }
    counts.guardians = guardians.size;
    await repo.updateImport(tx, imp.id, { counts });
    return counts;
  }

  private async createdGuardiansInTx(tx: Tx, importId: string): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (const row of await repo.allRows(tx, importId)) {
      if (row.status !== "imported") continue;
      for (const g of row.data?.guardians ?? []) {
        if (g.personId) map.set(guardianKey({ ...g, personId: null }, false), g.personId);
      }
    }
    return map;
  }

  private async importRowInTx(
    tx: Tx,
    context: TenantContext,
    imp: MemberImport,
    row: MemberImportStagingRow,
    data: RowData,
    state: BatchState,
    memberNumber: number | null,
    ids?: (rowNumber: number, guardian: number | null) => string,
  ): Promise<repo.ImportedRow> {
    const options = MemberImportOptionsSchema.parse(imp.options);
    if (!data.given || !data.family || !data.birthDate) throw new DomainError("invalid_input");
    let pin: { country: string; value: string } | null = null;
    if (data.personalIdentityNumber) {
      const plain = await this.encryption.decrypt(tx, data.personalIdentityNumber, pinAad(row.id));
      const at = plain.indexOf(":");
      pin = { country: plain.slice(0, at), value: plain.slice(at + 1) };
    }
    const guardians: IntakeGuardian[] = [];
    // The data.guardians index of each intake guardian.
    const sources: number[] = [];
    const invitedEmails = new Set<string>();
    for (const [index, g] of data.guardians.entries()) {
      const kind = g.kind as IntakeGuardian["kind"];
      const base = {
        kind,
        consentNote: isLinkedGuardianshipKind(kind) ? options.consentNote : null,
      };
      if (g.personId) {
        guardians.push({ ...base, target: { personId: g.personId } });
        sources.push(index);
        continue;
      }
      if (options.sendInvitations && g.email && state.invitations.left > 0) {
        if (invitedEmails.has(g.email)) continue;
        invitedEmails.add(g.email);
        state.invitations.left--;
        state.used++;
        guardians.push({ ...base, target: { email: g.email } });
        sources.push(index);
        continue;
      }
      if (!g.given || !g.family) continue;
      const key = guardianKey(g, false);
      const known = state.created.get(key) ?? state.known.get(key);
      guardians.push({
        ...base,
        target: known
          ? { personId: known, createdByClub: true }
          : {
              person: { given: g.given, family: g.family, phone: g.phone },
              ...(ids ? { id: ids(row.rowNumber, index) } : {}),
            },
      });
      sources.push(index);
    }
    const adultInvitation =
      options.sendInvitations && data.email && state.invitations.left > 0 ? data.email : null;
    if (adultInvitation) {
      state.invitations.left--;
      state.used++;
    }
    const member: IntakeMember = {
      names: { given: data.given, family: data.family },
      birthDate: data.birthDate,
      personalIdentityNumber: pin,
      gender: data.gender as IntakeMember["gender"],
      phone: data.phone,
      address: data.address,
      protected: data.protected,
      membershipType: (data.membershipType ??
        options.membershipType) as IntakeMember["membershipType"],
      startDate: data.startDate ?? options.startDate,
      memberNumber:
        options.memberNumbers === "keep" && data.memberNumber ? data.memberNumber : memberNumber,
      groupIds: data.groupIds,
      guardians,
      invitationEmail: adultInvitation,
      ...(ids ? { id: ids(row.rowNumber, null) } : {}),
    };
    const result = await this.intake.addInTx(tx, context, member, {
      existingPersonId: row.resolution === "same_person" ? row.matchPersonId : null,
      groupsChecked: true,
    });
    // Remember the guardians created now (another child of theirs later in the file).
    for (const [i, intakeGuardian] of guardians.entries()) {
      const personId = result.guardianPersonIds[i] ?? null;
      if (!personId) continue;
      const g = data.guardians[sources[i]!]!;
      if ("person" in intakeGuardian.target) state.created.set(guardianKey(g, false), personId);
      // The row records who each guardian became (the report counts people once).
      g.personId = personId;
    }
    return { id: row.id, personId: result.personId, data };
  }

  private async finishRun(
    context: TenantContext,
    imp: MemberImport,
    status: "done" | "failed",
    errorCode: string | null,
  ): Promise<void> {
    await this.db.withTenant(context, async (tx) => {
      await repo.markGuardianRowsImported(tx, imp.id);
      await repo.updateImport(tx, imp.id, { status, errorCode, finishedAt: new Date() });
      await this.refreshCountsInTx(tx, imp);
      await audit.record(tx, {
        action: "members.import.finished",
        resourceType: "member_import",
        resourceId: imp.id,
        changedFields: status === "failed" ? ["status", "error_code"] : ["status"],
      });
      await outbox.publish(tx, "members.import.finished", {
        importId: imp.id,
        clubId: imp.clubId,
      });
    });
  }
}
