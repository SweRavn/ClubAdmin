// SPDX-License-Identifier: AGPL-3.0-only
// Waiting-list entries of groups (P1.10b, ADR 0043). The order is
// (priority DESC, queued_at, id) everywhere (group_waitlist_entries_order_idx);
// places come from app.group_places (members, offers, accepted entries).

import { and, eq, inArray, schema, sql, type Tx } from "@clubadmin/db";
import {
  OPEN_WAITLIST_STATUSES,
  type WaitlistClosedReason,
  type WaitlistPriorityReason,
  type WaitlistStatus,
} from "@clubadmin/shared";

const { groupWaitlistEntries } = schema;

export type WaitlistEntryRow = typeof groupWaitlistEntries.$inferSelect;
export type NewWaitlistEntryRow = typeof groupWaitlistEntries.$inferInsert;

export const CLOSED_RETENTION_MONTHS = 12;

export async function insertEntry(tx: Tx, values: NewWaitlistEntryRow): Promise<WaitlistEntryRow> {
  const [row] = await tx.insert(groupWaitlistEntries).values(values).returning();
  return row!;
}

/** The entry locked for a decision; null if it is not in the transaction's club. */
export async function lockEntry(tx: Tx, id: string): Promise<WaitlistEntryRow | null> {
  const [row] = await tx
    .select()
    .from(groupWaitlistEntries)
    .where(eq(groupWaitlistEntries.id, id))
    .for("update");
  return row ?? null;
}

export async function updateEntry(
  tx: Tx,
  id: string,
  patch: Partial<NewWaitlistEntryRow>,
): Promise<WaitlistEntryRow> {
  const [row] = await tx
    .update(groupWaitlistEntries)
    .set(patch)
    .where(eq(groupWaitlistEntries.id, id))
    .returning();
  return row!;
}

/** The person's open entry in the group, if any (applying twice). */
export async function openEntryOf(
  tx: Tx,
  groupId: string,
  personId: string,
): Promise<WaitlistEntryRow | null> {
  const [row] = await tx
    .select()
    .from(groupWaitlistEntries)
    .where(
      and(
        eq(groupWaitlistEntries.groupId, groupId),
        eq(groupWaitlistEntries.personId, personId),
        inArray(groupWaitlistEntries.status, [...OPEN_WAITLIST_STATUSES]),
      ),
    );
  return row ?? null;
}

/** The person's open entry in the group, locked. */
export async function lockOpenEntryOf(
  tx: Tx,
  groupId: string,
  personId: string,
): Promise<WaitlistEntryRow | null> {
  const [row] = await tx
    .select()
    .from(groupWaitlistEntries)
    .where(
      and(
        eq(groupWaitlistEntries.groupId, groupId),
        eq(groupWaitlistEntries.personId, personId),
        inArray(groupWaitlistEntries.status, [...OPEN_WAITLIST_STATUSES]),
      ),
    )
    .for("update");
  return row ?? null;
}

/** People `waiting` ahead of the entry in its group's order (0: it is next). */
export async function waitingAhead(
  tx: Tx,
  entry: Pick<WaitlistEntryRow, "id" | "groupId" | "priority" | "queuedAt">,
): Promise<number> {
  const { rows } = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM public.group_waitlist_entries o
    WHERE o.group_id = ${entry.groupId} AND o.status = 'waiting' AND o.id <> ${entry.id}
      AND (o.priority > ${entry.priority}
        OR (o.priority = ${entry.priority}
          AND (o.queued_at, o.id) < (${entry.queuedAt.toISOString()}::timestamptz, ${entry.id}::uuid)))`);
  return rows[0]?.n ?? 0;
}

/** Number of `waiting` entries of the group (adding a member past them needs a reason). */
export async function waitingCount(tx: Tx, groupId: string): Promise<number> {
  const { rows } = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM public.group_waitlist_entries
    WHERE group_id = ${groupId} AND status = 'waiting'`);
  return rows[0]?.n ?? 0;
}

export type WaitlistSummaryRow = {
  capacity: number | null;
  occupied: number;
  waiting: number;
  offers: number;
  accepted: number;
};

/** Places and the open entries by status, in one statement. */
export async function summary(tx: Tx, groupId: string): Promise<WaitlistSummaryRow> {
  const { rows } = await tx.execute<WaitlistSummaryRow>(sql`
    SELECT p.capacity, p.occupied,
      count(*) FILTER (WHERE w.status = 'waiting')::int AS waiting,
      count(*) FILTER (WHERE w.status = 'offered')::int AS offers,
      count(*) FILTER (WHERE w.status = 'accepted')::int AS accepted
    FROM app.group_places(${groupId}) p
    LEFT JOIN public.group_waitlist_entries w
      ON w.group_id = ${groupId} AND w.status IN ('waiting', 'offered', 'accepted')
    GROUP BY p.capacity, p.occupied`);
  return rows[0] ?? { capacity: null, occupied: 0, waiting: 0, offers: 0, accepted: 0 };
}

export interface OwnerListRow {
  id: string;
  personId: string;
  requestedByPersonId: string;
  status: WaitlistStatus;
  position: number | null;
  birthYear: number | null;
  fitsBirthYears: boolean | null;
  fitsGenderCategory: boolean | null;
  queuedAt: Date;
  priority: number;
  priorityReason: WaitlistPriorityReason | null;
  applicantNote: string | null;
  ownerNote: string | null;
  offeredAt: Date | null;
  offerExpiresAt: Date | null;
  autoOffer: boolean;
  outOfOrderReason: string | null;
  closedReason: WaitlistClosedReason | null;
  decidedAt: Date | null;
  awaitingClub: boolean;
}

/**
 * A page of the group's waiting list for its owners. Open entries in queue
 * order (keyset on priority DESC, queued_at, id; the order index), the
 * position counted per waiting entry on the same index; closed entries of
 * the last 12 months newest first (keyset on decided time, id). Filters:
 * birth year, fit with the group's gender category.
 */
export async function ownerList(
  tx: Tx,
  groupId: string,
  query: {
    status: "open" | "closed";
    birthYear: number | null;
    fitsGender: boolean;
    cursor: string | null;
    limit: number;
  },
): Promise<{ rows: OwnerListRow[]; cursorFound: boolean }> {
  const open = query.status === "open";
  let anchor: { priority: number; queued_at: string; closed_at: string; id: string } | undefined;
  if (query.cursor) {
    const { rows } = await tx.execute<{
      priority: number;
      queued_at: string;
      closed_at: string;
      id: string;
    }>(sql`
      SELECT priority, queued_at::text, coalesce(decided_at, updated_at)::text AS closed_at, id
      FROM public.group_waitlist_entries WHERE id = ${query.cursor} AND group_id = ${groupId}`);
    anchor = rows[0];
    if (!anchor) return { rows: [], cursorFound: false };
  }
  const statusFilter = open
    ? sql`e.status IN ('waiting', 'offered', 'accepted')`
    : sql`e.status NOT IN ('waiting', 'offered', 'accepted')
        AND coalesce(e.decided_at, e.updated_at) > now() - make_interval(months => ${CLOSED_RETENTION_MONTHS})`;
  const keyset = !anchor
    ? sql`true`
    : open
      ? sql`(-e.priority, e.queued_at, e.id) > (${-anchor.priority}, ${anchor.queued_at}::timestamptz, ${anchor.id}::uuid)`
      : sql`(coalesce(e.decided_at, e.updated_at), e.id) < (${anchor.closed_at}::timestamptz, ${anchor.id}::uuid)`;
  const order = open
    ? sql`e.priority DESC, e.queued_at, e.id`
    : sql`coalesce(e.decided_at, e.updated_at) DESC, e.id DESC`;
  const fitsGender = sql`CASE
      WHEN g.gender_category IS NULL OR g.gender_category IN ('mixed', 'open') THEN true
      WHEN p.gender IS NULL THEN NULL
      ELSE p.gender = g.gender_category END`;
  const { rows } = await tx.execute<{
    id: string;
    person_id: string;
    requested_by_person_id: string;
    status: WaitlistStatus;
    position: number | null;
    birth_year: number | null;
    fits_birth_years: boolean | null;
    fits_gender: boolean | null;
    queued_at: string;
    priority: number;
    priority_reason: WaitlistPriorityReason | null;
    applicant_note: string | null;
    owner_note: string | null;
    offered_at: string | null;
    offer_expires_at: string | null;
    auto_offer: boolean;
    out_of_order_reason: string | null;
    closed_reason: WaitlistClosedReason | null;
    decided_at: string | null;
    awaiting_club: boolean;
  }>(sql`
    WITH g AS MATERIALIZED (
      SELECT birth_year_from, birth_year_to, gender_category FROM public.groups WHERE id = ${groupId}
    )
    SELECT e.id, e.person_id, e.requested_by_person_id, e.status,
      CASE WHEN e.status = 'waiting' THEN (
        SELECT count(*)::int + 1 FROM public.group_waitlist_entries o
        WHERE o.group_id = e.group_id AND o.status = 'waiting'
          AND (o.priority > e.priority
            OR (o.priority = e.priority AND (o.queued_at, o.id) < (e.queued_at, e.id)))
      ) END AS position,
      extract(year FROM p.birth_date)::int AS birth_year,
      CASE WHEN p.birth_date IS NULL OR (g.birth_year_from IS NULL AND g.birth_year_to IS NULL) THEN NULL
        ELSE extract(year FROM p.birth_date)::int
          BETWEEN coalesce(g.birth_year_from, 0) AND coalesce(g.birth_year_to, 9999) END
        AS fits_birth_years,
      ${fitsGender} AS fits_gender,
      e.queued_at::text, e.priority, e.priority_reason, e.applicant_note, e.owner_note,
      e.offered_at::text, e.offer_expires_at::text,
      (e.status = 'offered' AND e.offered_by_person_id IS NULL) AS auto_offer,
      e.out_of_order_reason, e.closed_reason, e.decided_at::text,
      (e.status = 'accepted') AS awaiting_club
    FROM public.group_waitlist_entries e
    CROSS JOIN g
    -- One index probe per entry (LIMIT keeps the planner from joining the
    -- whole people table).
    LEFT JOIN LATERAL (
      SELECT x.birth_date, x.gender FROM public.people x WHERE x.id = e.person_id LIMIT 1
    ) p ON true
    WHERE e.group_id = ${groupId} AND ${statusFilter} AND ${keyset}
      ${query.birthYear === null ? sql`` : sql`AND extract(year FROM p.birth_date)::int = ${query.birthYear}`}
      ${query.fitsGender ? sql`AND (${fitsGender}) IS TRUE` : sql``}
    ORDER BY ${order}
    LIMIT ${query.limit}`);
  const date = (v: string | null) => (v === null ? null : new Date(v));
  return {
    cursorFound: true,
    rows: rows.map((r) => ({
      id: r.id,
      personId: r.person_id,
      requestedByPersonId: r.requested_by_person_id,
      status: r.status,
      position: r.position,
      birthYear: r.birth_year,
      fitsBirthYears: r.fits_birth_years,
      fitsGenderCategory: r.fits_gender,
      queuedAt: new Date(r.queued_at),
      priority: r.priority,
      priorityReason: r.priority_reason,
      applicantNote: r.applicant_note,
      ownerNote: r.owner_note,
      offeredAt: date(r.offered_at),
      offerExpiresAt: date(r.offer_expires_at),
      autoOffer: r.auto_offer,
      outOfOrderReason: r.out_of_order_reason,
      closedReason: r.closed_reason,
      decidedAt: date(r.decided_at),
      awaitingClub: r.awaiting_club,
    })),
  };
}

/** The person's `accepted` entries in the club, locked (their join request was approved). */
export async function acceptedEntriesOf(
  tx: Tx,
  clubId: string,
  personId: string,
): Promise<WaitlistEntryRow[]> {
  return tx
    .select()
    .from(groupWaitlistEntries)
    .where(
      and(
        eq(groupWaitlistEntries.clubId, clubId),
        eq(groupWaitlistEntries.personId, personId),
        eq(groupWaitlistEntries.status, "accepted"),
      ),
    )
    .for("update");
}

/** Closes the person's open entries in the club with the reason; their IDs. */
export async function closeOpenEntriesOf(
  tx: Tx,
  clubId: string,
  personId: string,
  status: "withdrawn" | "removed",
  reason: WaitlistClosedReason,
  decidedBy: string | null,
): Promise<string[]> {
  const rows = await tx
    .update(groupWaitlistEntries)
    .set({
      status,
      closedReason: reason,
      decidedAt: sql`now()`,
      decidedByPersonId: decidedBy,
      offerExpiresAt: null,
    })
    .where(
      and(
        eq(groupWaitlistEntries.clubId, clubId),
        eq(groupWaitlistEntries.personId, personId),
        inArray(groupWaitlistEntries.status, [...OPEN_WAITLIST_STATUSES]),
      ),
    )
    .returning({ id: groupWaitlistEntries.id });
  return rows.map((r) => r.id);
}

/** Open entries created with the join request (withdrawing the last one withdraws it). */
export async function openEntriesWithJoinRequest(tx: Tx, joinRequestId: string): Promise<number> {
  const { rows } = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM public.group_waitlist_entries
    WHERE join_request_id = ${joinRequestId} AND status IN ('waiting', 'offered', 'accepted')`);
  return rows[0]?.n ?? 0;
}

// --- The applicant's side ----------------------------------------------------------------

export interface OwnEntryRow {
  id: string;
  clubId: string;
  groupId: string;
  personId: string;
  requestedByPersonId: string;
  status: WaitlistStatus;
  queuedAt: Date;
  offerExpiresAt: Date | null;
  closedReason: WaitlistClosedReason | null;
  decidedAt: Date | null;
}

/**
 * The entries of the given people (the caller and their wards) in every club,
 * open ones and those closed in the last 12 months (own_relationships;
 * group_waitlist_entries_person_idx).
 */
export async function ownEntries(tx: Tx, personIds: readonly string[]): Promise<OwnEntryRow[]> {
  if (personIds.length === 0) return [];
  return tx
    .select({
      id: groupWaitlistEntries.id,
      clubId: groupWaitlistEntries.clubId,
      groupId: groupWaitlistEntries.groupId,
      personId: groupWaitlistEntries.personId,
      requestedByPersonId: groupWaitlistEntries.requestedByPersonId,
      status: groupWaitlistEntries.status,
      queuedAt: groupWaitlistEntries.queuedAt,
      offerExpiresAt: groupWaitlistEntries.offerExpiresAt,
      closedReason: groupWaitlistEntries.closedReason,
      decidedAt: groupWaitlistEntries.decidedAt,
    })
    .from(groupWaitlistEntries)
    .where(
      and(
        inArray(groupWaitlistEntries.personId, [...personIds]),
        sql`(${groupWaitlistEntries.status} IN ('waiting', 'offered', 'accepted')
          OR coalesce(${groupWaitlistEntries.decidedAt}, ${groupWaitlistEntries.updatedAt})
            > now() - make_interval(months => ${CLOSED_RETENTION_MONTHS}))`,
      ),
    )
    .orderBy(sql`${groupWaitlistEntries.queuedAt} DESC`, groupWaitlistEntries.id)
    .limit(100);
}

export interface PositionRow {
  position: number | null;
  waiting: number;
  groupName: string;
  clubName: string;
  clubTimeZone: string;
}

/** Positions of the caller's entries across clubs, in one call (app.waitlist_positions). */
export async function positions(
  tx: Tx,
  entryIds: readonly string[],
): Promise<Map<string, PositionRow>> {
  if (entryIds.length === 0) return new Map();
  const { rows } = await tx.execute<{
    entry_id: string;
    position: number | null;
    waiting_count: number;
    group_name: string;
    club_name: string;
    club_time_zone: string;
  }>(sql`SELECT * FROM app.waitlist_positions(${pgUuidArray(entryIds)})`);
  return new Map(
    rows.map((r) => [
      r.entry_id,
      {
        position: r.position,
        waiting: r.waiting_count,
        groupName: r.group_name,
        clubName: r.club_name,
        clubTimeZone: r.club_time_zone,
      },
    ]),
  );
}

function pgUuidArray(ids: readonly string[]) {
  return sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;
}

export interface OpenGroupRow {
  id: string;
  name: string;
  kind: string;
  parentName: string | null;
  sport: string | null;
  birthYearFrom: number | null;
  birthYearTo: number | null;
  genderCategory: string | null;
  level: string | null;
  full: boolean;
  waiting: number;
}

type OpenGroupDbRow = {
  id: string;
  name: string;
  kind: string;
  parent_name: string | null;
  sport: string | null;
  birth_year_from: number | null;
  birth_year_to: number | null;
  gender_category: string | null;
  level: string | null;
  full_now: boolean;
  waiting_count: number;
};

const toOpenGroup = (r: OpenGroupDbRow): OpenGroupRow => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  parentName: r.parent_name,
  sport: r.sport,
  birthYearFrom: r.birth_year_from,
  birthYearTo: r.birth_year_to,
  genderCategory: r.gender_category,
  level: r.level,
  full: r.full_now,
  waiting: r.waiting_count,
});

/** Groups open for applications from outside the club (app.club_open_groups). */
export async function publicOpenGroups(tx: Tx, clubId: string): Promise<OpenGroupRow[]> {
  const { rows } = await tx.execute<OpenGroupDbRow>(
    sql`SELECT * FROM app.club_open_groups(${clubId})`,
  );
  return rows.map(toOpenGroup);
}

/** For insiders (a tenant transaction): every unarchived group with a waiting list. */
export async function insiderOpenGroups(tx: Tx, clubId: string): Promise<OpenGroupRow[]> {
  const { rows } = await tx.execute<OpenGroupDbRow>(sql`
    SELECT g.id, g.name, g.kind, p.name AS parent_name, g.sport, g.birth_year_from,
      g.birth_year_to, g.gender_category, g.level,
      coalesce(pl.capacity IS NOT NULL AND pl.occupied >= pl.capacity, false) AS full_now,
      (SELECT count(*)::int FROM public.group_waitlist_entries w
       WHERE w.group_id = g.id AND w.status = 'waiting') AS waiting_count
    FROM public.groups g
    LEFT JOIN public.groups p ON p.club_id = g.club_id AND p.id = g.parent_group_id
    LEFT JOIN LATERAL app.group_places(g.id) pl ON true
    WHERE g.club_id = ${clubId} AND g.archived_at IS NULL AND g.admission_mode = 'waitlist'
    ORDER BY g.name, g.id
    LIMIT 200`);
  return rows.map(toOpenGroup);
}

// --- The club managers' view ---------------------------------------------------------------

export type ClubGroupCountsRow = {
  id: string;
  name: string;
  capacity: number | null;
  occupied: number;
  waiting: number;
  offers: number;
  accepted: number;
};

/** Per group with a waiting list or open entries: places and counts (groups_club_idx). */
export async function clubGroupCounts(tx: Tx, clubId: string): Promise<ClubGroupCountsRow[]> {
  const { rows } = await tx.execute<ClubGroupCountsRow>(sql`
    SELECT g.id, g.name, pl.capacity, pl.occupied,
      count(w.id) FILTER (WHERE w.status = 'waiting')::int AS waiting,
      count(w.id) FILTER (WHERE w.status = 'offered')::int AS offers,
      count(w.id) FILTER (WHERE w.status = 'accepted')::int AS accepted
    FROM public.groups g
    LEFT JOIN LATERAL app.group_places(g.id) pl ON true
    LEFT JOIN public.group_waitlist_entries w
      ON w.group_id = g.id AND w.status IN ('waiting', 'offered', 'accepted')
    WHERE g.club_id = ${clubId} AND g.archived_at IS NULL
    GROUP BY g.id, g.name, pl.capacity, pl.occupied
    HAVING g.admission_mode = 'waitlist' OR count(w.id) > 0
    ORDER BY g.name, g.id
    LIMIT 500`);
  return rows;
}

export interface DecisionRow {
  id: string;
  kind: "offer" | "admission" | "queue_bypass";
  groupId: string;
  groupName: string;
  personId: string;
  decidedByPersonId: string | null;
  decidedAt: Date;
  reason: string;
}

/**
 * Out-of-order offers and admissions (entries with a reason;
 * group_waitlist_entries_out_of_order_idx) and queue bypasses (memberships
 * with a reason; group_memberships_queue_bypass_idx) since `from`, newest
 * first, keyset on (time, id).
 */
export async function decisions(
  tx: Tx,
  clubId: string,
  query: { from: Date; cursor: string | null; limit: number },
): Promise<{ rows: DecisionRow[]; cursorFound: boolean }> {
  const union = sql`
    SELECT e.id, CASE WHEN e.status IN ('offered', 'accepted', 'declined', 'expired') OR e.offered_at IS NOT NULL
        THEN 'offer' ELSE 'admission' END AS kind,
      e.group_id, e.person_id, e.decided_by_person_id, e.decided_at AS at, e.out_of_order_reason AS reason
    FROM public.group_waitlist_entries e
    WHERE e.club_id = ${clubId} AND e.out_of_order_reason IS NOT NULL AND e.decided_at >= ${query.from.toISOString()}::timestamptz
    UNION ALL
    SELECT m.id, 'queue_bypass', m.group_id, m.person_id,
      (SELECT a.actor_person_id FROM audit.events a
       WHERE a.resource_type = 'group_membership' AND a.resource_id = m.id
       ORDER BY a.created_at LIMIT 1),
      m.created_at, m.queue_bypass_reason
    FROM public.group_memberships m
    WHERE m.club_id = ${clubId} AND m.queue_bypass_reason IS NOT NULL AND m.created_at >= ${query.from.toISOString()}::timestamptz`;
  let anchor: { at: string; id: string } | undefined;
  if (query.cursor) {
    const { rows } = await tx.execute<{ at: string; id: string }>(
      sql`SELECT at::text, id FROM (${union}) d WHERE d.id = ${query.cursor}`,
    );
    anchor = rows[0];
    if (!anchor) return { rows: [], cursorFound: false };
  }
  const { rows } = await tx.execute<{
    id: string;
    kind: DecisionRow["kind"];
    group_id: string;
    group_name: string;
    person_id: string;
    decided_by_person_id: string | null;
    at: string;
    reason: string;
  }>(sql`
    SELECT d.id, d.kind, d.group_id, g.name AS group_name, d.person_id, d.decided_by_person_id,
      d.at::text, d.reason
    FROM (${union}) d
    JOIN public.groups g ON g.club_id = ${clubId} AND g.id = d.group_id
    WHERE ${anchor ? sql`(d.at, d.id) < (${anchor.at}::timestamptz, ${anchor.id}::uuid)` : sql`true`}
    ORDER BY d.at DESC, d.id DESC
    LIMIT ${query.limit}`);
  return {
    cursorFound: true,
    rows: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      groupId: r.group_id,
      groupName: r.group_name,
      personId: r.person_id,
      decidedByPersonId: r.decided_by_person_id,
      decidedAt: new Date(r.at),
      reason: r.reason,
    })),
  };
}

/** The club of a group the caller may apply for (app.waitlist_group_club), else null. */
export async function groupClubOf(tx: Tx, groupId: string): Promise<string | null> {
  const { rows } = await tx.execute<{ club_id: string | null }>(
    sql`SELECT app.waitlist_group_club(${groupId}) AS club_id`,
  );
  return rows[0]?.club_id ?? null;
}

/** The end of the day `days` after today in the time zone (an offer's deadline). */
export async function offerExpiry(tx: Tx, timeZone: string, days: number): Promise<Date> {
  const { rows } = await tx.execute<{ at: string }>(sql`
    SELECT ((((now() AT TIME ZONE ${timeZone})::date + ${days}::int + 1)::timestamp)
      AT TIME ZONE ${timeZone})::text AS at`);
  return new Date(rows[0]!.at);
}
