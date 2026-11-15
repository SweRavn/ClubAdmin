// SPDX-License-Identifier: AGPL-3.0-only
// Meetings' and tasks' rows (P2.4 part B): agenda templates, agenda items
// with their decisions, papers and action items (tasks), the minutes a
// meeting was assembled into, and "Mina uppgifter".

import { sql, type Tx } from "@clubadmin/db";
import type { MeetingKind, TaskAssignmentStatus, TaskKind } from "@clubadmin/shared";

export type MeetingKey = { kind: "activity"; id: string } | { kind: "event"; id: string };

const column = (m: MeetingKey) => sql.raw(m.kind === "activity" ? "activity_id" : "event_id");

// --- Meetings -----------------------------------------------------------------

/** The meeting's title, group and date; null when it is not the club's. */
export async function meeting(
  tx: Tx,
  m: MeetingKey,
): Promise<{ title: string; groupId: string | null; startsAt: Date } | null> {
  const { rows } = await tx.execute<{ title: string; group_id: string | null; starts_at: string }>(
    m.kind === "activity"
      ? sql`SELECT a.title, (SELECT ag.group_id FROM public.activity_groups ag
              WHERE ag.activity_id = a.id ORDER BY ag.group_id LIMIT 1) AS group_id,
              a.starts_at::text FROM public.activities a WHERE a.id = ${m.id}::uuid`
      : sql`SELECT e.title, NULL::uuid AS group_id, e.starts_at::text
            FROM public.events e WHERE e.id = ${m.id}::uuid`,
  );
  const row = rows[0];
  return row
    ? { title: row.title, groupId: row.group_id, startsAt: new Date(row.starts_at) }
    : null;
}

/** Takes the meeting's agenda lock for the rest of the transaction (one editor at a time). */
export async function lockAgenda(tx: Tx, m: MeetingKey): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('agenda:' || ${m.id}, 0))`);
}

// --- Templates ------------------------------------------------------------------

export interface TemplateRow {
  id: string;
  meetingKind: MeetingKind;
  name: string;
  items: { title: string; durationMinutes?: number | null }[];
}

export async function templates(tx: Tx, clubId: string): Promise<TemplateRow[]> {
  const { rows } = await tx.execute<{
    id: string;
    meeting_kind: MeetingKind;
    name: string;
    items: TemplateRow["items"];
  }>(sql`
    SELECT t.id, t.meeting_kind, t.name, t.items FROM public.agenda_templates t
    WHERE t.club_id = ${clubId}::uuid ORDER BY t.name, t.id LIMIT 100`);
  return rows.map((r) => ({ id: r.id, meetingKind: r.meeting_kind, name: r.name, items: r.items }));
}

export async function upsertTemplate(
  tx: Tx,
  input: { id: string; clubId: string; by: string } & Omit<TemplateRow, "id">,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO public.agenda_templates (id, club_id, meeting_kind, name, items, created_by_person_id)
    VALUES (${input.id}, ${input.clubId}, ${input.meetingKind}, ${input.name},
      ${JSON.stringify(input.items)}::jsonb, ${input.by})
    ON CONFLICT (id) DO UPDATE SET meeting_kind = EXCLUDED.meeting_kind, name = EXCLUDED.name,
      items = EXCLUDED.items
    WHERE agenda_templates.club_id = EXCLUDED.club_id`);
}

export async function deleteTemplatesExcept(
  tx: Tx,
  clubId: string,
  keep: readonly string[],
): Promise<void> {
  await tx.execute(sql`
    DELETE FROM public.agenda_templates
    WHERE club_id = ${clubId}::uuid AND NOT (id = ANY (${`{${keep.join(",")}}`}::uuid[]))`);
}

// --- Agenda -------------------------------------------------------------------

export interface ItemRow {
  id: string;
  position: number;
  title: string;
  presenterPersonId: string | null;
  durationMinutes: number | null;
  minutes: string | null;
}

export interface ActionRow {
  taskId: string;
  itemId: string;
  title: string;
  description: string | null;
  dueDate: string | null;
  assignees: { assignmentId: string; personId: string; status: TaskAssignmentStatus }[];
}

/** A meeting's agenda in one query set: items, decisions, papers and action items. */
export async function agenda(
  tx: Tx,
  m: MeetingKey,
): Promise<{
  items: ItemRow[];
  decisions: Map<string, { id: string; text: string }[]>;
  papers: Map<string, { id: string; name: string }[]>;
  actions: Map<string, ActionRow[]>;
}> {
  const { rows: items } = await tx.execute<{
    id: string;
    position: number;
    title: string;
    presenter_person_id: string | null;
    duration_minutes: number | null;
    minutes: string | null;
  }>(sql`
    SELECT i.id, i.position, i.title, i.presenter_person_id, i.duration_minutes, i.minutes
    FROM public.meeting_agenda_items i WHERE i.${column(m)} = ${m.id}::uuid
    ORDER BY i.position, i.id LIMIT 200`);
  const ids = `{${items.map((i) => i.id).join(",")}}`;
  const decisions = new Map<string, { id: string; text: string }[]>();
  const papers = new Map<string, { id: string; name: string }[]>();
  const actions = new Map<string, ActionRow[]>();
  if (items.length > 0) {
    const { rows: ds } = await tx.execute<{ id: string; item_id: string; text: string }>(sql`
      SELECT d.id, d.item_id, d.text FROM public.meeting_decisions d
      WHERE d.item_id = ANY (${ids}::uuid[]) ORDER BY d.item_id, d.position`);
    for (const d of ds) push(decisions, d.item_id, { id: d.id, text: d.text });
    const { rows: ps } = await tx.execute<{ item_id: string; id: string; name: string }>(sql`
      SELECT p.item_id, doc.id, doc.name FROM public.agenda_item_documents p
      JOIN public.documents doc ON doc.id = p.document_id AND doc.deleted_at IS NULL
      WHERE p.item_id = ANY (${ids}::uuid[]) ORDER BY p.item_id, doc.name, doc.id`);
    for (const p of ps) push(papers, p.item_id, { id: p.id, name: p.name });
    const { rows: ts } = await tx.execute<{
      id: string;
      item_id: string;
      title: string;
      description: string | null;
      due_date: string | null;
      assignees: ActionRow["assignees"];
    }>(sql`
      SELECT t.id, t.source_agenda_item_id AS item_id, t.title, t.description, t.due_date::text,
        coalesce((SELECT jsonb_agg(jsonb_build_object('assignmentId', a.id, 'personId', a.person_id,
          'status', a.status) ORDER BY a.id) FROM public.task_assignments a WHERE a.task_id = t.id),
          '[]'::jsonb) AS assignees
      FROM public.tasks t WHERE t.source_agenda_item_id = ANY (${ids}::uuid[])
      ORDER BY t.source_agenda_item_id, t.id`);
    for (const t of ts) {
      push(actions, t.item_id, {
        taskId: t.id,
        itemId: t.item_id,
        title: t.title,
        description: t.description,
        dueDate: t.due_date,
        assignees: t.assignees,
      });
    }
  }
  return {
    items: items.map((i) => ({
      id: i.id,
      position: i.position,
      title: i.title,
      presenterPersonId: i.presenter_person_id,
      durationMinutes: i.duration_minutes,
      minutes: i.minutes,
    })),
    decisions,
    papers,
    actions,
  };
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export async function upsertItem(
  tx: Tx,
  m: MeetingKey,
  input: { id: string; clubId: string } & Omit<ItemRow, "id">,
): Promise<boolean> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO public.meeting_agenda_items
      (id, club_id, ${column(m)}, position, title, presenter_person_id, duration_minutes, minutes)
    VALUES (${input.id}, ${input.clubId}, ${m.id}, ${input.position}, ${input.title},
      ${input.presenterPersonId}, ${input.durationMinutes}, ${input.minutes})
    ON CONFLICT (id) DO UPDATE SET position = EXCLUDED.position, title = EXCLUDED.title,
      presenter_person_id = EXCLUDED.presenter_person_id,
      duration_minutes = EXCLUDED.duration_minutes, minutes = EXCLUDED.minutes
    WHERE meeting_agenda_items.${column(m)} = ${m.id}::uuid
    RETURNING id`);
  return rows.length > 0;
}

/** Removes the items not kept, with their action items (decisions and papers cascade). */
export async function deleteItemsExcept(tx: Tx, m: MeetingKey, keep: readonly string[]) {
  const kept = `{${keep.join(",")}}`;
  await tx.execute(sql`
    DELETE FROM public.tasks t USING public.meeting_agenda_items i
    WHERE t.source_agenda_item_id = i.id AND i.${column(m)} = ${m.id}::uuid
      AND NOT (i.id = ANY (${kept}::uuid[]))`);
  await tx.execute(sql`
    DELETE FROM public.meeting_agenda_items
    WHERE ${column(m)} = ${m.id}::uuid AND NOT (id = ANY (${kept}::uuid[]))`);
}

export async function replaceDecisions(
  tx: Tx,
  clubId: string,
  itemId: string,
  texts: readonly string[],
): Promise<void> {
  await tx.execute(sql`DELETE FROM public.meeting_decisions WHERE item_id = ${itemId}::uuid`);
  for (const [index, text] of texts.entries()) {
    await tx.execute(sql`
      INSERT INTO public.meeting_decisions (club_id, item_id, position, text)
      VALUES (${clubId}, ${itemId}, ${index + 1}, ${text})`);
  }
}

/** Sets an item's papers; false when a document is not the club's (or deleted). */
export async function replacePapers(
  tx: Tx,
  clubId: string,
  itemId: string,
  documentIds: readonly string[],
): Promise<boolean> {
  const ids = `{${documentIds.join(",")}}`;
  const { rows } = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM public.documents d
    WHERE d.id = ANY (${ids}::uuid[]) AND d.deleted_at IS NULL`);
  if ((rows[0]?.n ?? 0) !== documentIds.length) return false;
  await tx.execute(sql`
    DELETE FROM public.agenda_item_documents
    WHERE item_id = ${itemId}::uuid AND NOT (document_id = ANY (${ids}::uuid[]))`);
  await tx.execute(sql`
    INSERT INTO public.agenda_item_documents (club_id, item_id, document_id)
    SELECT ${clubId}, ${itemId}, d FROM unnest(${ids}::uuid[]) AS d
    ON CONFLICT (item_id, document_id) DO NOTHING`);
  return true;
}

// --- Tasks --------------------------------------------------------------------

export async function upsertTask(
  tx: Tx,
  input: {
    id: string;
    clubId: string;
    groupId: string | null;
    kind: TaskKind;
    title: string;
    description: string | null;
    dueDate: string | null;
    itemId: string;
    by: string;
  },
): Promise<boolean> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO public.tasks
      (id, club_id, group_id, kind, title, description, due_date, source_agenda_item_id,
       created_by_person_id)
    VALUES (${input.id}, ${input.clubId}, ${input.groupId}, ${input.kind}, ${input.title},
      ${input.description}, ${input.dueDate}::date, ${input.itemId}, ${input.by})
    ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description,
      due_date = EXCLUDED.due_date
    WHERE tasks.source_agenda_item_id = ${input.itemId}::uuid
    RETURNING id`);
  return rows.length > 0;
}

export async function deleteTasksExcept(tx: Tx, itemId: string, keep: readonly string[]) {
  await tx.execute(sql`
    DELETE FROM public.tasks
    WHERE source_agenda_item_id = ${itemId}::uuid
      AND NOT (id = ANY (${`{${keep.join(",")}}`}::uuid[]))`);
}

/** Sets a task's assignees: kept ones keep their status unless given, new ones are planned. */
export async function replaceAssignees(
  tx: Tx,
  input: {
    clubId: string;
    taskId: string;
    assignees: readonly { personId: string; status?: TaskAssignmentStatus | undefined }[];
    by: string;
  },
): Promise<void> {
  const ids = `{${input.assignees.map((a) => a.personId).join(",")}}`;
  await tx.execute(sql`
    DELETE FROM public.task_assignments
    WHERE task_id = ${input.taskId}::uuid AND NOT (person_id = ANY (${ids}::uuid[]))`);
  for (const a of input.assignees) {
    await tx.execute(sql`
      INSERT INTO public.task_assignments (club_id, task_id, person_id, status, marked_by_person_id, marked_at)
      VALUES (${input.clubId}, ${input.taskId}, ${a.personId}, ${a.status ?? "planned"},
        CASE WHEN ${a.status ?? null}::text IN ('done', 'missed') THEN ${input.by}::uuid END,
        CASE WHEN ${a.status ?? null}::text IN ('done', 'missed') THEN now() END)
      ON CONFLICT (task_id, person_id) DO UPDATE SET
        status = coalesce(${a.status ?? null}, task_assignments.status),
        marked_by_person_id = CASE WHEN ${a.status ?? null}::text IS NULL
          OR ${a.status ?? null}::text = task_assignments.status
          THEN task_assignments.marked_by_person_id ELSE ${input.by}::uuid END,
        marked_at = CASE WHEN ${a.status ?? null}::text IS NULL
          OR ${a.status ?? null}::text = task_assignments.status
          THEN task_assignments.marked_at ELSE now() END`);
  }
}

/** An assignment's status (the caller's own, through "Mina uppgifter"). */
export async function markAssignment(
  tx: Tx,
  input: { assignmentId: string; status: TaskAssignmentStatus; by: string },
): Promise<{ taskId: string; activityId: string | null; eventId: string | null } | null> {
  const { rows } = await tx.execute<{
    task_id: string;
    activity_id: string | null;
    event_id: string | null;
  }>(sql`
    WITH marked AS (
      UPDATE public.task_assignments SET status = ${input.status},
        marked_by_person_id = ${input.by}, marked_at = now()
      WHERE id = ${input.assignmentId}::uuid RETURNING task_id)
    SELECT m.task_id, coalesce(i.activity_id, t.source_activity_id) AS activity_id,
      coalesce(i.event_id, t.source_event_id) AS event_id
    FROM marked m JOIN public.tasks t ON t.id = m.task_id
    LEFT JOIN public.meeting_agenda_items i ON i.id = t.source_agenda_item_id`);
  const row = rows[0];
  return row ? { taskId: row.task_id, activityId: row.activity_id, eventId: row.event_id } : null;
}

// --- Minutes ------------------------------------------------------------------

export async function minutesOf(tx: Tx, m: MeetingKey): Promise<string | null> {
  const { rows } = await tx.execute<{ document_id: string }>(sql`
    SELECT n.document_id FROM public.meeting_minutes n WHERE n.${column(m)} = ${m.id}::uuid`);
  return rows[0]?.document_id ?? null;
}

export async function saveMinutes(
  tx: Tx,
  m: MeetingKey,
  input: { clubId: string; documentId: string; by: string },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO public.meeting_minutes (club_id, ${column(m)}, document_id, assembled_by_person_id)
    VALUES (${input.clubId}, ${m.id}, ${input.documentId}, ${input.by})
    ON CONFLICT (${column(m)}) WHERE ${column(m)} IS NOT NULL
    DO UPDATE SET assembled_by_person_id = EXCLUDED.assembled_by_person_id, assembled_at = now()`);
}

// --- "Mina uppgifter" -------------------------------------------------------------

export interface MyTaskRow {
  assignmentId: string;
  taskId: string;
  clubId: string;
  clubName: string;
  groupId: string | null;
  groupName: string | null;
  kind: TaskKind;
  title: string;
  description: string | null;
  dueDate: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  personId: string;
  status: TaskAssignmentStatus;
  markedAt: Date | null;
  activityId: string | null;
  eventId: string | null;
  meetingTitle: string | null;
  sortDay: string;
}

export async function myTasks(
  tx: Tx,
  input: { cursor: string | null; limit: number; open: boolean },
): Promise<MyTaskRow[]> {
  const { rows } = await tx.execute<{
    assignment_id: string;
    task_id: string;
    club_id: string;
    club_name: string;
    group_id: string | null;
    group_name: string | null;
    kind: TaskKind;
    title: string;
    description: string | null;
    due_date: string | null;
    starts_at: string | null;
    ends_at: string | null;
    person_id: string;
    status: TaskAssignmentStatus;
    marked_at: string | null;
    source_activity_id: string | null;
    source_event_id: string | null;
    meeting_title: string | null;
    sort_day: string;
  }>(sql`
    SELECT assignment_id, task_id, club_id, club_name, group_id, group_name, kind, title,
      description, due_date::text, starts_at::text, ends_at::text, person_id, status,
      marked_at::text, source_activity_id, source_event_id, meeting_title, sort_day::text
    FROM app.my_tasks(${input.cursor}::uuid, ${input.limit}, ${input.open})`);
  return rows.map((r) => ({
    assignmentId: r.assignment_id,
    taskId: r.task_id,
    clubId: r.club_id,
    clubName: r.club_name,
    groupId: r.group_id,
    groupName: r.group_name,
    kind: r.kind,
    title: r.title,
    description: r.description,
    dueDate: r.due_date,
    startsAt: r.starts_at ? new Date(r.starts_at) : null,
    endsAt: r.ends_at ? new Date(r.ends_at) : null,
    personId: r.person_id,
    status: r.status,
    markedAt: r.marked_at ? new Date(r.marked_at) : null,
    activityId: r.source_activity_id,
    eventId: r.source_event_id,
    meetingTitle: r.meeting_title,
    sortDay: r.sort_day,
  }));
}

export async function assignmentClub(tx: Tx, assignmentId: string): Promise<string | null> {
  const { rows } = await tx.execute<{ club_id: string | null }>(sql`
    SELECT app.my_task_assignment_club(${assignmentId}::uuid) AS club_id`);
  return rows[0]?.club_id ?? null;
}
