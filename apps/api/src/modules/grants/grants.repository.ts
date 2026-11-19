// SPDX-License-Identifier: AGPL-3.0-only
// What grant reports read (P2.7 part B): the club's held sessions in a
// period with who was present, the people's data the plugin declares, the
// members on a reference date, and the reports themselves. Every query runs
// in the caller's tenant transaction and starts from the club and its date
// indexes (activities_club_starts_idx, attendance_records_activity_idx) or
// from the people's keys.

import { sql, type Tx } from "@clubadmin/db";

const uuidArray = (ids: readonly string[]) => `{${ids.join(",")}}`;

export interface HeldSessionRow {
  activityId: string;
  title: string;
  kind: "training" | "match" | "meeting" | "other";
  startsAt: Date;
  endsAt: Date;
  /** The activity's first group (by ID): its sport and adapted flag. */
  groupId: string;
  sport: string | null;
  adapted: boolean;
}

/** Held (scheduled, started) activities of the club in the range with any attendance mark. */
export async function heldSessions(
  tx: Tx,
  range: { from: Date; to: Date },
): Promise<HeldSessionRow[]> {
  const { rows } = await tx.execute<{
    id: string;
    title: string;
    kind: HeldSessionRow["kind"];
    starts_at: string;
    ends_at: string;
    group_id: string;
    sport: string | null;
    adapted: boolean;
  }>(sql`
    SELECT a.id, a.title, a.kind, a.starts_at, a.ends_at, g.id AS group_id, g.sport, g.adapted
    FROM public.activities a
    CROSS JOIN LATERAL (
      SELECT ag.group_id FROM public.activity_groups ag
      WHERE ag.activity_id = a.id ORDER BY ag.group_id LIMIT 1) first
    JOIN public.groups g ON g.id = first.group_id
    WHERE a.club_id = app.current_club_id()
      AND a.starts_at >= ${range.from.toISOString()}::timestamptz
      AND a.starts_at < least(${range.to.toISOString()}::timestamptz, now())
      AND a.status = 'scheduled'
      AND EXISTS (SELECT 1 FROM public.attendance_records r
                  WHERE r.club_id = a.club_id AND r.activity_id = a.id)
    ORDER BY a.starts_at, a.id`);
  return rows.map((r) => ({
    activityId: r.id,
    title: r.title,
    kind: r.kind,
    startsAt: new Date(r.starts_at),
    endsAt: new Date(r.ends_at),
    groupId: r.group_id,
    sport: r.sport,
    adapted: r.adapted,
  }));
}

/** Who was marked present in these sessions. */
export async function present(
  tx: Tx,
  activityIds: readonly string[],
): Promise<{ activityId: string; personId: string; role: "participant" | "leader" }[]> {
  if (activityIds.length === 0) return [];
  const { rows } = await tx.execute<{
    activity_id: string;
    person_id: string;
    role: "participant" | "leader";
  }>(sql`
    SELECT activity_id, person_id, role FROM public.attendance_records
    WHERE club_id = app.current_club_id()
      AND activity_id = ANY (${uuidArray(activityIds)}::uuid[]) AND status = 'present'
    ORDER BY activity_id, person_id`);
  return rows.map((r) => ({ activityId: r.activity_id, personId: r.person_id, role: r.role }));
}

/** Each activity's first group (by ID) with its sport and adapted flag. */
export async function sessionGroups(
  tx: Tx,
  activityIds: readonly string[],
): Promise<Map<string, { groupId: string; sport: string | null; adapted: boolean }>> {
  if (activityIds.length === 0) return new Map();
  const { rows } = await tx.execute<{
    activity_id: string;
    group_id: string;
    sport: string | null;
    adapted: boolean;
  }>(sql`
    SELECT DISTINCT ON (ag.activity_id) ag.activity_id, g.id AS group_id, g.sport, g.adapted
    FROM public.activity_groups ag
    JOIN public.groups g ON g.id = ag.group_id
    WHERE ag.club_id = app.current_club_id()
      AND ag.activity_id = ANY (${uuidArray(activityIds)}::uuid[])
    ORDER BY ag.activity_id, ag.group_id`);
  return new Map(
    rows.map((r) => [r.activity_id, { groupId: r.group_id, sport: r.sport, adapted: r.adapted }]),
  );
}

/** People with a club membership valid on the date (not applications). */
export async function membersOn(tx: Tx, date: string): Promise<string[]> {
  const { rows } = await tx.execute<{ person_id: string }>(sql`
    SELECT DISTINCT person_id FROM public.club_memberships
    WHERE club_id = app.current_club_id() AND status <> 'applied'
      AND valid_from < (${date}::date + 1)
      AND (valid_to IS NULL OR valid_to >= ${date}::date)
    ORDER BY person_id`);
  return rows.map((r) => r.person_id);
}

export interface PersonDataRow {
  id: string;
  membership: {
    status: "applied" | "active" | "paused" | "left";
    type: string;
    validFrom: Date;
    validTo: Date | null;
  } | null;
}

/** The people's latest membership of the club (their identity comes from PeopleService). */
export async function peopleData(tx: Tx, ids: readonly string[]): Promise<PersonDataRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await tx.execute<{
    id: string;
    status: "applied" | "active" | "paused" | "left" | null;
    membership_type: string | null;
    valid_from: string | null;
    valid_to: string | null;
  }>(sql`
    SELECT p.id, m.status, m.membership_type, m.valid_from, m.valid_to
    FROM public.people p
    LEFT JOIN LATERAL (
      SELECT cm.status, cm.membership_type, cm.valid_from, cm.valid_to
      FROM public.club_memberships cm
      WHERE cm.club_id = app.current_club_id() AND cm.person_id = p.id AND cm.status <> 'applied'
      ORDER BY cm.valid_from DESC LIMIT 1) m ON true
    WHERE p.id = ANY (${uuidArray([...new Set(ids)])}::uuid[])
    ORDER BY p.id`);
  return rows.map((r) => ({
    id: r.id,
    membership:
      r.status && r.valid_from
        ? {
            status: r.status,
            type: r.membership_type ?? "active",
            validFrom: new Date(r.valid_from),
            validTo: r.valid_to ? new Date(r.valid_to) : null,
          }
        : null,
  }));
}

/** The people's group functions on the date, with the groups' sport and adapted flag. */
export async function groupsOn(
  tx: Tx,
  ids: readonly string[],
  date: string,
): Promise<
  { personId: string; groupId: string; function: string; sport: string | null; adapted: boolean }[]
> {
  if (ids.length === 0) return [];
  const { rows } = await tx.execute<{
    person_id: string;
    group_id: string;
    function: string;
    sport: string | null;
    adapted: boolean;
  }>(sql`
    SELECT gm.person_id, gm.group_id, gm.function, g.sport, g.adapted
    FROM public.group_memberships gm
    JOIN public.groups g ON g.id = gm.group_id
    WHERE gm.club_id = app.current_club_id()
      AND gm.person_id = ANY (${uuidArray([...new Set(ids)])}::uuid[])
      AND gm.valid_from < (${date}::date + 1)
      AND (gm.valid_to IS NULL OR gm.valid_to > ${date}::date)
    ORDER BY gm.person_id, gm.group_id, gm.function`);
  return rows.map((r) => ({
    personId: r.person_id,
    groupId: r.group_id,
    function: r.function,
    sport: r.sport,
    adapted: r.adapted,
  }));
}

// --- Reports ------------------------------------------------------------------------

export interface ReportRow {
  id: string;
  pluginId: string;
  schemeKey: string;
  periodKey: string;
  periodFrom: string;
  periodTo: string;
  status: string;
  evaluation: unknown;
  totals: unknown;
  evaluatedAt: Date | null;
  lockedByPersonId: string | null;
  lockedAt: Date | null;
  attendanceChangedAt: Date | null;
}

type ReportDb = {
  id: string;
  plugin_id: string;
  scheme_key: string;
  period_key: string;
  period_from: string;
  period_to: string;
  status: string;
  evaluation: unknown;
  totals: unknown;
  evaluated_at: string | null;
  locked_by_person_id: string | null;
  locked_at: string | null;
  attendance_changed_at: string | null;
};

const REPORT_COLUMNS = sql`id, plugin_id, scheme_key, period_key, period_from::text,
  period_to::text, status, evaluation, totals, evaluated_at, locked_by_person_id, locked_at,
  attendance_changed_at`;

const toReport = (r: ReportDb): ReportRow => ({
  id: r.id,
  pluginId: r.plugin_id,
  schemeKey: r.scheme_key,
  periodKey: r.period_key,
  periodFrom: r.period_from,
  periodTo: r.period_to,
  status: r.status,
  evaluation: r.evaluation,
  totals: r.totals,
  evaluatedAt: r.evaluated_at ? new Date(r.evaluated_at) : null,
  lockedByPersonId: r.locked_by_person_id,
  lockedAt: r.locked_at ? new Date(r.locked_at) : null,
  attendanceChangedAt: r.attendance_changed_at ? new Date(r.attendance_changed_at) : null,
});

export async function reportByKey(
  tx: Tx,
  key: { pluginId: string; scheme: string; period: string },
): Promise<ReportRow | null> {
  const { rows } = await tx.execute<ReportDb>(sql`
    SELECT ${REPORT_COLUMNS} FROM public.grant_reports
    WHERE club_id = app.current_club_id() AND plugin_id = ${key.pluginId}
      AND scheme_key = ${key.scheme} AND period_key = ${key.period}`);
  return rows[0] ? toReport(rows[0]) : null;
}

export async function report(tx: Tx, reportId: string): Promise<ReportRow | null> {
  const { rows } = await tx.execute<ReportDb>(sql`
    SELECT ${REPORT_COLUMNS} FROM public.grant_reports WHERE id = ${reportId}`);
  return rows[0] ? toReport(rows[0]) : null;
}

/** Writes a draft's evaluation (never a locked report's). */
export async function saveDraft(
  tx: Tx,
  key: { pluginId: string; scheme: string; period: string; from: string; to: string },
  evaluation: unknown,
  totals: unknown,
): Promise<ReportRow> {
  const { rows } = await tx.execute<ReportDb>(sql`
    INSERT INTO public.grant_reports
      (club_id, plugin_id, scheme_key, period_key, period_from, period_to, evaluation, totals,
       evaluated_at)
    VALUES (app.current_club_id(), ${key.pluginId}, ${key.scheme}, ${key.period},
      ${key.from}::date, ${key.to}::date, ${JSON.stringify(evaluation)}::jsonb,
      ${JSON.stringify(totals)}::jsonb, now())
    ON CONFLICT (club_id, plugin_id, scheme_key, period_key) DO UPDATE
      SET evaluation = excluded.evaluation, totals = excluded.totals, evaluated_at = now()
      WHERE public.grant_reports.status = 'draft'
    RETURNING ${REPORT_COLUMNS}`);
  if (rows[0]) return toReport(rows[0]);
  return (await reportByKey(tx, key))!;
}

export async function lock(tx: Tx, reportId: string, personId: string | null): Promise<boolean> {
  const result = await tx.execute(sql`
    UPDATE public.grant_reports
    SET status = 'locked', locked_at = now(), locked_by_person_id = ${personId}
    WHERE id = ${reportId} AND status = 'draft'`);
  return (result.rowCount ?? 0) > 0;
}

export async function markExported(tx: Tx, reportId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE public.grant_reports SET status = 'exported'
    WHERE id = ${reportId} AND status = 'locked'`);
}
