// SPDX-License-Identifier: AGPL-3.0-only
// The member_imports and member_import_rows tables (P1.3b). Rows carry the
// file's values for the importer's preview; names never leave the database
// here except through the import presenter.

import { and, asc, desc, eq, gt, schema, sql, type Tx } from "@clubadmin/db";
import type {
  MemberImportCounts,
  MemberImportIssue,
  MemberImportResolution,
  MemberImportRowStatus,
} from "@clubadmin/shared";

const { memberImports, memberImportRows } = schema;

export type MemberImportRow = typeof memberImports.$inferSelect;
export type ImportRowRow = typeof memberImportRows.$inferSelect;

export async function insertImport(
  tx: Tx,
  values: typeof memberImports.$inferInsert,
): Promise<MemberImportRow> {
  const [row] = await tx.insert(memberImports).values(values).returning();
  return row!;
}

export async function findImport(tx: Tx, id: string): Promise<MemberImportRow | null> {
  const [row] = await tx.select().from(memberImports).where(eq(memberImports.id, id));
  return row ?? null;
}

export async function lockImport(tx: Tx, id: string): Promise<MemberImportRow | null> {
  const [row] = await tx.select().from(memberImports).where(eq(memberImports.id, id)).for("update");
  return row ?? null;
}

export async function updateImport(
  tx: Tx,
  id: string,
  values: Partial<typeof memberImports.$inferInsert>,
): Promise<void> {
  await tx.update(memberImports).set(values).where(eq(memberImports.id, id));
}

/** Newest first, keyset by ID (UUIDv7: creation order). */
export async function listImports(
  tx: Tx,
  clubId: string,
  page: { cursor: string | null; limit: number },
): Promise<MemberImportRow[]> {
  return tx
    .select()
    .from(memberImports)
    .where(
      and(
        eq(memberImports.clubId, clubId),
        page.cursor ? sql`${memberImports.id} < ${page.cursor}` : undefined,
      ),
    )
    .orderBy(desc(memberImports.id))
    .limit(page.limit);
}

/** Imports started in the club in the last 24 hours. */
export async function recentImportCount(tx: Tx, clubId: string): Promise<number> {
  const { rows } = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM public.member_imports
    WHERE club_id = ${clubId} AND created_at > now() - interval '1 day'`);
  return rows[0]?.n ?? 0;
}

/** Invitations the club sent in the last 24 hours (guardians; the rate limit of imports). */
export async function recentClubInvitationCount(tx: Tx, clubId: string): Promise<number> {
  const { rows } = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM public.guardian_invitations
    WHERE club_id = ${clubId} AND created_at > now() - interval '1 day'`);
  return rows[0]?.n ?? 0;
}

const CHUNK = 1000;

export async function insertRows(
  tx: Tx,
  rows: readonly (typeof memberImportRows.$inferInsert)[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await tx.insert(memberImportRows).values(rows.slice(i, i + CHUNK));
  }
}

export async function hasRows(tx: Tx, importId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ ok: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM public.member_import_rows WHERE import_id = ${importId}) AS ok`);
  return rows[0]?.ok === true;
}

/** All rows in file order (validation). */
export async function allRows(tx: Tx, importId: string): Promise<ImportRowRow[]> {
  return tx
    .select()
    .from(memberImportRows)
    .where(eq(memberImportRows.importId, importId))
    .orderBy(asc(memberImportRows.rowNumber));
}

export interface ValidatedRow {
  id: string;
  data: unknown;
  status: MemberImportRowStatus;
  issues: MemberImportIssue[];
  familyKey: string | null;
  matchPersonId: string | null;
  resolution: MemberImportResolution | null;
}

/** Writes the validation of many rows (chunks of 1000, one statement each). */
export async function updateValidatedRows(tx: Tx, rows: readonly ValidatedRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK).map((r) => ({
      id: r.id,
      data: r.data,
      status: r.status,
      issues: r.issues,
      family_key: r.familyKey,
      match_person_id: r.matchPersonId,
      resolution: r.resolution,
    }));
    await tx.execute(sql`
      UPDATE public.member_import_rows r SET
        data = v.data, status = v.status, issues = v.issues, family_key = v.family_key,
        match_person_id = v.match_person_id, resolution = v.resolution
      FROM jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb) AS v(
        id uuid, data jsonb, status text, issues text[], family_key text,
        match_person_id uuid, resolution text)
      WHERE r.id = v.id`);
  }
}

export async function rowsPage(
  tx: Tx,
  importId: string,
  page: { status: MemberImportRowStatus | undefined; after: number; limit: number },
): Promise<ImportRowRow[]> {
  return tx
    .select()
    .from(memberImportRows)
    .where(
      and(
        eq(memberImportRows.importId, importId),
        page.status ? eq(memberImportRows.status, page.status) : undefined,
        gt(memberImportRows.rowNumber, page.after),
      ),
    )
    .orderBy(asc(memberImportRows.rowNumber))
    .limit(page.limit);
}

export async function findRow(
  tx: Tx,
  importId: string,
  rowNumber: number,
): Promise<ImportRowRow | null> {
  const [row] = await tx
    .select()
    .from(memberImportRows)
    .where(and(eq(memberImportRows.importId, importId), eq(memberImportRows.rowNumber, rowNumber)));
  return row ?? null;
}

export async function updateRow(
  tx: Tx,
  id: string,
  values: Partial<typeof memberImportRows.$inferInsert>,
): Promise<void> {
  await tx.update(memberImportRows).set(values).where(eq(memberImportRows.id, id));
}

/** The next rows to import (status new), in file order. */
export async function rowsToImport(
  tx: Tx,
  importId: string,
  after: number,
  limit: number,
): Promise<ImportRowRow[]> {
  return tx
    .select()
    .from(memberImportRows)
    .where(
      and(
        eq(memberImportRows.importId, importId),
        eq(memberImportRows.status, "new"),
        gt(memberImportRows.rowNumber, after),
      ),
    )
    .orderBy(asc(memberImportRows.rowNumber))
    .limit(limit);
}

/** Counts per row status. */
export async function statusCounts(
  tx: Tx,
  importId: string,
): Promise<Pick<MemberImportCounts, "rows" | MemberImportRowStatus>> {
  const { rows } = await tx.execute<{ status: MemberImportRowStatus; n: number }>(sql`
    SELECT status, count(*)::int AS n FROM public.member_import_rows
    WHERE import_id = ${importId} GROUP BY status`);
  const counts = { rows: 0, new: 0, duplicate: 0, error: 0, skipped: 0, imported: 0 };
  for (const r of rows) {
    counts[r.status] = r.n;
    counts.rows += r.n;
  }
  return counts;
}

/** A guardian's own rows (one row per guardian) are done with their family's members. */
export async function markGuardianRowsImported(tx: Tx, importId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE public.member_import_rows SET status = 'imported'
    WHERE import_id = ${importId} AND status = 'new' AND data->>'relation' IS NOT NULL`);
}

export interface ImportedRow {
  id: string;
  personId: string;
  data: unknown;
}

/** Marks a batch's rows imported, with the person each became (one statement). */
export async function markRowsImported(tx: Tx, rows: readonly ImportedRow[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.execute(sql`
    UPDATE public.member_import_rows r SET status = 'imported', person_id = v.person_id, data = v.data
    FROM jsonb_to_recordset(${JSON.stringify(
      rows.map((r) => ({ id: r.id, person_id: r.personId, data: r.data })),
    )}::jsonb) AS v(id uuid, person_id uuid, data jsonb)
    WHERE r.id = v.id`);
}
