// SPDX-License-Identifier: AGPL-3.0-only
// Expense claims' queries (P2.5 part B, ADR 0048). The module owns
// expense_claims and expense_claim_lines; it reads (never writes) the roles
// that grant attestation, under the caller's tenant RLS. IDs only towards
// people.

import { sql, type Tx } from "@clubadmin/db";
import type { ExpenseClaimKind, ExpenseClaimStatus } from "@clubadmin/shared";

const uuidArray = (ids: readonly string[]) => `{${ids.join(",")}}`;

export interface ClaimLineRow {
  id: string;
  offerId: string | null;
  description: string;
  quantity: number;
  unitAmountMinor: number;
  amountMinor: number;
}

export interface ClaimRow {
  id: string;
  clubId: string;
  clubName?: string;
  kind: ExpenseClaimKind;
  claimantPersonId: string;
  groupId: string;
  groupName: string;
  activityId: string | null;
  routedToPersonId: string | null;
  amountMinor: number;
  currency: string;
  status: ExpenseClaimStatus;
  decidedByPersonId: string | null;
  decidedAt: Date | null;
  reason: string | null;
  createdAt: Date;
  lines: ClaimLineRow[];
}

type LineDb = {
  id: string;
  offer_id: string | null;
  description: string;
  quantity: string | number;
  unit_amount_minor: number;
  amount_minor: string | number;
};

type ClaimDb = {
  id: string;
  club_id: string;
  club_name?: string;
  kind: ExpenseClaimKind;
  claimant_person_id: string;
  group_id: string;
  group_name: string | null;
  activity_id: string | null;
  routed_to_person_id: string | null;
  amount_minor: string | number;
  currency: string;
  status: ExpenseClaimStatus;
  decided_by_person_id: string | null;
  decided_at: string | Date | null;
  reason: string | null;
  created_at: string | Date;
  lines: LineDb[];
};

const toLine = (l: LineDb): ClaimLineRow => ({
  id: l.id,
  offerId: l.offer_id,
  description: l.description,
  quantity: Number(l.quantity),
  unitAmountMinor: l.unit_amount_minor,
  amountMinor: Number(l.amount_minor),
});

const toClaim = (r: ClaimDb): ClaimRow => ({
  id: r.id,
  clubId: r.club_id,
  ...(r.club_name === undefined ? {} : { clubName: r.club_name }),
  kind: r.kind,
  claimantPersonId: r.claimant_person_id,
  groupId: r.group_id,
  groupName: r.group_name ?? "",
  activityId: r.activity_id,
  routedToPersonId: r.routed_to_person_id,
  amountMinor: Number(r.amount_minor),
  currency: r.currency,
  status: r.status,
  decidedByPersonId: r.decided_by_person_id,
  decidedAt: r.decided_at === null ? null : new Date(r.decided_at),
  reason: r.reason,
  createdAt: new Date(r.created_at),
  lines: r.lines.map(toLine),
});

const CLAIM_SELECT = sql`
  SELECT c.id, c.club_id, c.kind, c.claimant_person_id, c.group_id,
    (SELECT g.name FROM public.groups g WHERE g.id = c.group_id) AS group_name,
    c.activity_id, c.routed_to_person_id, c.amount_minor, c.currency, c.status,
    c.decided_by_person_id, c.decided_at, c.reason, c.created_at,
    coalesce((SELECT jsonb_agg(jsonb_build_object('id', l.id, 'offer_id', l.offer_id,
        'description', l.description, 'quantity', l.quantity,
        'unit_amount_minor', l.unit_amount_minor, 'amount_minor', l.amount_minor) ORDER BY l.id)
      FROM public.expense_claim_lines l WHERE l.claim_id = c.id), '[]') AS lines
  FROM public.expense_claims c`;

/** Drives already in a claim that was not rejected. */
export async function claimedOffers(tx: Tx, offerIds: readonly string[]): Promise<Set<string>> {
  if (offerIds.length === 0) return new Set();
  const { rows } = await tx.execute<{ offer_id: string }>(sql`
    SELECT DISTINCT l.offer_id FROM public.expense_claim_lines l
    JOIN public.expense_claims c ON c.id = l.claim_id
    WHERE l.offer_id = ANY (${uuidArray(offerIds)}::uuid[]) AND c.status <> 'rejected'`);
  return new Set(rows.map((r) => r.offer_id));
}

/** Whether the person may attest the group's claims (a group role, or the club's). */
export async function mayAttest(
  tx: Tx,
  clubId: string,
  personId: string,
  groupId: string,
): Promise<boolean> {
  const { rows } = await tx.execute<{ ok: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM public.club_role_assignments r
      JOIN public.role_permissions rp ON rp.club_id = r.club_id AND rp.role_id = r.role_id
      WHERE r.club_id = ${clubId}::uuid AND r.person_id = ${personId}::uuid AND r.valid_to IS NULL
        AND rp.permission = 'club.expenses.attest'
    ) OR EXISTS (
      -- An owner of the group or of a group above it.
      WITH RECURSIVE up AS (
        SELECT g.id, g.parent_group_id FROM public.groups g WHERE g.id = ${groupId}::uuid
        UNION
        SELECT p.id, p.parent_group_id FROM public.groups p JOIN up ON p.id = up.parent_group_id
      )
      SELECT 1 FROM up JOIN public.group_owners o ON o.group_id = up.id
      WHERE o.person_id = ${personId}::uuid AND o.valid_to IS NULL
    ) OR EXISTS (
      SELECT 1 FROM public.group_memberships gm
      JOIN public.role_permissions rp ON rp.club_id = gm.club_id AND rp.role_id = gm.role_id
      WHERE gm.club_id = ${clubId}::uuid AND gm.group_id = ${groupId}::uuid
        AND gm.person_id = ${personId}::uuid AND gm.valid_to IS NULL
        AND rp.permission = 'group.expenses.attest'
    ) AS ok`);
  return rows[0]?.ok ?? false;
}

/** These groups of the club and every group under them. */
export async function groupsUnder(
  tx: Tx,
  clubId: string,
  groupIds: readonly string[],
): Promise<string[]> {
  if (groupIds.length === 0) return [];
  const { rows } = await tx.execute<{ id: string }>(sql`
    WITH RECURSIVE down AS (
      SELECT g.id FROM public.groups g
      WHERE g.club_id = ${clubId}::uuid AND g.id = ANY (${uuidArray(groupIds)}::uuid[])
      UNION
      SELECT c.id FROM public.groups c JOIN down ON c.club_id = ${clubId}::uuid AND c.parent_group_id = down.id
    )
    SELECT id FROM down`);
  return rows.map((r) => r.id);
}

export async function insertClaim(
  tx: Tx,
  values: {
    clubId: string;
    kind: ExpenseClaimKind;
    claimantPersonId: string;
    groupId: string;
    activityId: string | null;
    routedToPersonId: string | null;
    amountMinor: number;
    currency: string;
    lines: Omit<ClaimLineRow, "id">[];
  },
): Promise<string> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO public.expense_claims (club_id, kind, claimant_person_id, group_id, activity_id,
      routed_to_person_id, amount_minor, currency)
    VALUES (${values.clubId}::uuid, ${values.kind}, ${values.claimantPersonId}::uuid,
      ${values.groupId}::uuid, ${values.activityId}::uuid, ${values.routedToPersonId}::uuid,
      ${values.amountMinor}, ${values.currency})
    RETURNING id`);
  const id = rows[0]!.id;
  await tx.execute(sql`
    INSERT INTO public.expense_claim_lines (club_id, claim_id, offer_id, description, quantity,
      unit_amount_minor, amount_minor)
    SELECT ${values.clubId}::uuid, ${id}::uuid, v.offer_id, v.description, v.quantity,
      v.unit_amount_minor, v.amount_minor
    FROM jsonb_to_recordset(${JSON.stringify(
      values.lines.map((l) => ({
        offer_id: l.offerId,
        description: l.description,
        quantity: l.quantity,
        unit_amount_minor: l.unitAmountMinor,
        amount_minor: l.amountMinor,
      })),
    )}::jsonb) AS v(offer_id uuid, description text, quantity numeric, unit_amount_minor integer,
      amount_minor bigint)`);
  return id;
}

export async function claim(tx: Tx, claimId: string, lock = false): Promise<ClaimRow | null> {
  if (lock) {
    await tx.execute(
      sql`SELECT 1 FROM public.expense_claims WHERE id = ${claimId}::uuid FOR UPDATE`,
    );
  }
  const { rows } = await tx.execute<ClaimDb>(sql`${CLAIM_SELECT} WHERE c.id = ${claimId}::uuid`);
  return rows[0] ? toClaim(rows[0]) : null;
}

/**
 * The club's claims of a status, oldest first (keyset by ID): every group's
 * (`groupIds` null) or these groups'. By (club, status) or (group, status).
 */
export async function queue(
  tx: Tx,
  clubId: string,
  options: {
    status: ExpenseClaimStatus;
    groupIds: readonly string[] | null;
    cursor: string | null;
    limit: number;
  },
): Promise<ClaimRow[]> {
  if (options.groupIds?.length === 0) return [];
  const { rows } = await tx.execute<ClaimDb>(sql`
    ${CLAIM_SELECT}
    WHERE c.club_id = ${clubId}::uuid AND c.status = ${options.status}
      ${options.groupIds ? sql`AND c.group_id = ANY (${uuidArray(options.groupIds)}::uuid[])` : sql``}
      ${options.cursor ? sql`AND c.id > ${options.cursor}::uuid` : sql``}
    ORDER BY c.id
    LIMIT ${options.limit}`);
  return rows.map(toClaim);
}

export async function decide(
  tx: Tx,
  claimId: string,
  values: { status: "approved" | "rejected"; by: string; reason: string | null },
): Promise<void> {
  await tx.execute(sql`
    UPDATE public.expense_claims SET status = ${values.status},
      decided_by_person_id = ${values.by}::uuid, decided_at = now(), reason = ${values.reason}
    WHERE id = ${claimId}::uuid AND status = 'submitted'`);
}

/** The caller's claims across their clubs, newest first (app.my_expense_claims). */
export async function myClaims(
  tx: Tx,
  options: { cursor: string | null; limit: number },
): Promise<ClaimRow[]> {
  const { rows } = await tx.execute<ClaimDb & { claim_id: string }>(sql`
    SELECT club_id, club_name, claim_id, kind, group_id, group_name, activity_id, amount_minor,
      currency, status, routed_to_person_id, decided_by_person_id, decided_at, reason, created_at,
      lines, NULL::uuid AS claimant_person_id
    FROM app.my_expense_claims(${options.cursor}::uuid, ${options.limit})`);
  return rows
    .map((r) => toClaim({ ...r, id: r.claim_id, claimant_person_id: "" }))
    .sort((a, b) => (a.id < b.id ? 1 : -1))
    .slice(0, options.limit);
}

export interface ExportRow {
  id: string;
  claimantPersonId: string;
  groupName: string;
  kind: ExpenseClaimKind;
  amountMinor: number;
  currency: string;
  status: ExpenseClaimStatus;
  decidedAt: Date;
  quantity: number;
}

/**
 * Approved (and already exported) claims decided in [from, to), oldest
 * first, at most `limit`; by the club's decided index.
 */
export async function exportRows(
  tx: Tx,
  clubId: string,
  range: { from: Date; to: Date },
  limit: number,
): Promise<ExportRow[]> {
  const { rows } = await tx.execute<{
    id: string;
    claimant_person_id: string;
    group_name: string | null;
    kind: ExpenseClaimKind;
    amount_minor: string | number;
    currency: string;
    status: ExpenseClaimStatus;
    decided_at: string | Date;
    quantity: string | number;
  }>(sql`
    SELECT c.id, c.claimant_person_id, (SELECT g.name FROM public.groups g WHERE g.id = c.group_id)
        AS group_name, c.kind, c.amount_minor, c.currency, c.status, c.decided_at,
      (SELECT coalesce(sum(l.quantity), 0) FROM public.expense_claim_lines l WHERE l.claim_id = c.id)
        AS quantity
    FROM public.expense_claims c
    WHERE c.club_id = ${clubId}::uuid AND c.decided_at >= ${range.from} AND c.decided_at < ${range.to}
      AND c.status IN ('approved', 'exported')
    ORDER BY c.decided_at, c.id
    LIMIT ${limit}`);
  return rows.map((r) => ({
    id: r.id,
    claimantPersonId: r.claimant_person_id,
    groupName: r.group_name ?? "",
    kind: r.kind,
    amountMinor: Number(r.amount_minor),
    currency: r.currency,
    status: r.status,
    decidedAt: new Date(r.decided_at),
    quantity: Number(r.quantity),
  }));
}

export async function markExported(tx: Tx, claimIds: readonly string[]): Promise<void> {
  if (claimIds.length === 0) return;
  await tx.execute(sql`
    UPDATE public.expense_claims SET status = 'exported', exported_at = now()
    WHERE id = ANY (${uuidArray(claimIds)}::uuid[]) AND status = 'approved'`);
}
