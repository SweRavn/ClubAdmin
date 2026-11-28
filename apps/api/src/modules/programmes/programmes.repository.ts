// SPDX-License-Identifier: AGPL-3.0-only
// Queries on programmes and templates (P2.9, ADR 0054). Templates hold no
// people; programmes reach people only through their items, which belong to
// the activities and duties modules.

import { sql, type Tx } from "@clubadmin/db";
import type { ProgrammeEventSettings, ProgrammeItemValues, ProgrammeSlot } from "@clubadmin/shared";

const uuidArray = (ids: readonly string[]) => `{${ids.join(",")}}`;

// --- Templates --------------------------------------------------------------------

export interface TemplateRow {
  id: string;
  clubId: string;
  groupId: string | null;
  name: string;
  description: string | null;
  dayCount: number;
  eventSettings: ProgrammeEventSettings | null;
  archived: boolean;
  itemCount: number;
}

type TemplateDb = {
  id: string;
  club_id: string;
  group_id: string | null;
  name: string;
  description: string | null;
  day_count: number;
  event_settings: ProgrammeEventSettings | null;
  archived: boolean;
  item_count: number;
};

const toTemplate = (r: TemplateDb): TemplateRow => ({
  id: r.id,
  clubId: r.club_id,
  groupId: r.group_id,
  name: r.name,
  description: r.description,
  dayCount: r.day_count,
  eventSettings: r.event_settings,
  archived: r.archived,
  itemCount: Number(r.item_count),
});

const TEMPLATE_SELECT = sql`
  SELECT t.id, t.club_id, t.group_id, t.name, t.description, t.day_count, t.event_settings,
    t.archived_at IS NOT NULL AS archived,
    (SELECT count(*) FROM public.programme_template_items i WHERE i.template_id = t.id) AS item_count
  FROM public.programme_templates t`;

export async function template(tx: Tx, id: string, lock = false): Promise<TemplateRow | null> {
  if (lock) {
    await tx.execute(
      sql`SELECT 1 FROM public.programme_templates WHERE id = ${id}::uuid FOR UPDATE`,
    );
  }
  const { rows } = await tx.execute<TemplateDb>(sql`${TEMPLATE_SELECT} WHERE t.id = ${id}::uuid`);
  return rows[0] ? toTemplate(rows[0]) : null;
}

/**
 * Templates of the current club: the club's and those of `groupIds`
 * (null: every group's), keyset by ID.
 */
export async function templates(
  tx: Tx,
  filter: { groupIds: readonly string[] | null; archived: boolean },
  page: { cursor: string | null; limit: number },
): Promise<TemplateRow[]> {
  const groups =
    filter.groupIds === null
      ? sql`TRUE`
      : sql`(t.group_id IS NULL OR t.group_id = ANY (${uuidArray(filter.groupIds)}::uuid[]))`;
  const { rows } = await tx.execute<TemplateDb>(sql`
    ${TEMPLATE_SELECT}
    WHERE t.club_id = app.current_club_id() AND ${groups}
      AND (t.archived_at IS NOT NULL) = ${filter.archived}
      AND (${page.cursor}::uuid IS NULL OR t.id > ${page.cursor}::uuid)
    ORDER BY t.id LIMIT ${page.limit}`);
  return rows.map(toTemplate);
}

export async function insertTemplate(
  tx: Tx,
  row: {
    id: string;
    clubId: string;
    groupId: string | null;
    name: string;
    description: string | null;
    dayCount: number;
    eventSettings: ProgrammeEventSettings | null;
    by: string | null;
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO public.programme_templates (id, club_id, group_id, name, description, day_count,
      event_settings, created_by_person_id)
    VALUES (${row.id}, ${row.clubId}, ${row.groupId}, ${row.name}, ${row.description},
      ${row.dayCount}, ${row.eventSettings === null ? null : JSON.stringify(row.eventSettings)}::jsonb,
      ${row.by})`);
}

export async function updateTemplate(
  tx: Tx,
  id: string,
  values: {
    name: string;
    description: string | null;
    dayCount: number;
    eventSettings: ProgrammeEventSettings | null;
    archived: boolean;
  },
): Promise<void> {
  await tx.execute(sql`
    UPDATE public.programme_templates SET name = ${values.name},
      description = ${values.description}, day_count = ${values.dayCount},
      event_settings = ${values.eventSettings === null ? null : JSON.stringify(values.eventSettings)}::jsonb,
      archived_at = CASE WHEN ${values.archived} THEN coalesce(archived_at, now()) ELSE NULL END
    WHERE id = ${id}::uuid`);
}

export async function slots(tx: Tx, templateId: string): Promise<ProgrammeSlot[]> {
  const { rows } = await tx.execute<{
    key: string;
    label: string;
    default_group_id: string | null;
  }>(sql`
    SELECT key, label, default_group_id FROM public.programme_template_slots
    WHERE template_id = ${templateId}::uuid ORDER BY sort, key`);
  return rows.map((r) => ({ key: r.key, label: r.label, defaultGroupId: r.default_group_id }));
}

export interface StoredItem extends Omit<ProgrammeItemValues, "ref" | "parentRef"> {
  id: string;
  parentItemId: string | null;
}

type ItemDb = {
  id: string;
  kind: "activity" | "duty_shift";
  parent_item_id: string | null;
  day_offset: number;
  start_time: string;
  end_day_offset: number;
  end_time: string;
  slot_keys: string[];
  activity_kind: ProgrammeItemValues["activityKind"];
  kind_label: string | null;
  title: string;
  notes: string | null;
  location_id: string | null;
  location_text: string | null;
  meet_minutes_before: number | null;
  meet_place: string | null;
  transport_mode: ProgrammeItemValues["transportMode"];
  home_away: ProgrammeItemValues["homeAway"];
  opponent: string | null;
  response_mode: ProgrammeItemValues["responseMode"];
  duty_type_id: string | null;
  needed: number | null;
};

export async function items(tx: Tx, templateId: string): Promise<StoredItem[]> {
  const { rows } = await tx.execute<ItemDb>(sql`
    SELECT id, kind, parent_item_id, day_offset, to_char(start_time, 'HH24:MI') AS start_time,
      end_day_offset, to_char(end_time, 'HH24:MI') AS end_time, slot_keys, activity_kind,
      kind_label, title, notes, location_id, location_text, meet_minutes_before, meet_place,
      transport_mode, home_away, opponent, response_mode, duty_type_id, needed
    FROM public.programme_template_items
    WHERE template_id = ${templateId}::uuid ORDER BY sort, id`);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    parentItemId: r.parent_item_id,
    dayOffset: r.day_offset,
    startTime: r.start_time,
    endDayOffset: r.end_day_offset,
    endTime: r.end_time,
    slotKeys: r.slot_keys,
    activityKind: r.activity_kind,
    kindLabel: r.kind_label,
    title: r.title,
    notes: r.notes,
    locationId: r.location_id,
    locationText: r.location_text,
    meetMinutesBefore: r.meet_minutes_before,
    meetPlace: r.meet_place,
    transportMode: r.transport_mode,
    homeAway: r.home_away,
    opponent: r.opponent,
    responseMode: r.response_mode,
    dutyTypeId: r.duty_type_id,
    needed: r.needed,
  }));
}

/** Replaces a template's slots and items: one statement each (at most 300 items). */
export async function replaceContent(
  tx: Tx,
  clubId: string,
  templateId: string,
  content: { slots: readonly ProgrammeSlot[]; items: readonly StoredItem[] },
): Promise<void> {
  await tx.execute(sql`
    DELETE FROM public.programme_template_slots WHERE template_id = ${templateId}::uuid`);
  await tx.execute(sql`
    DELETE FROM public.programme_template_items WHERE template_id = ${templateId}::uuid`);
  if (content.slots.length > 0) {
    await tx.execute(sql`
      INSERT INTO public.programme_template_slots (template_id, club_id, key, label,
        default_group_id, sort)
      SELECT ${templateId}::uuid, ${clubId}::uuid, s.key, s.label, s."defaultGroupId", s.sort
      FROM jsonb_to_recordset(${JSON.stringify(content.slots.map((s, sort) => ({ ...s, sort })))}::jsonb)
        AS s(key text, label text, "defaultGroupId" uuid, sort integer)`);
  }
  if (content.items.length > 0) {
    // Parents first: a shift refers to its activity item (self reference).
    const ordered = content.items.map((item, sort) => ({ ...item, sort }));
    await tx.execute(sql`
      INSERT INTO public.programme_template_items (id, template_id, club_id, kind,
        parent_item_id, sort, day_offset, start_time, end_day_offset, end_time, slot_keys,
        activity_kind, kind_label, title, notes, location_id, location_text,
        meet_minutes_before, meet_place, transport_mode, home_away, opponent, response_mode,
        duty_type_id, needed)
      SELECT i.id, ${templateId}::uuid, ${clubId}::uuid, i.kind, i."parentItemId", i.sort,
        i."dayOffset", i."startTime"::time, i."endDayOffset", i."endTime"::time,
        ARRAY(SELECT jsonb_array_elements_text(i."slotKeys")), i."activityKind", i."kindLabel",
        i.title, i.notes, i."locationId", i."locationText", i."meetMinutesBefore", i."meetPlace",
        i."transportMode", i."homeAway", i.opponent, i."responseMode", i."dutyTypeId", i.needed
      FROM jsonb_to_recordset(${JSON.stringify(ordered)}::jsonb) AS i(id uuid, kind text,
        "parentItemId" uuid, sort integer, "dayOffset" integer, "startTime" text,
        "endDayOffset" integer, "endTime" text, "slotKeys" jsonb, "activityKind" text,
        "kindLabel" text, title text, notes text, "locationId" uuid, "locationText" text,
        "meetMinutesBefore" integer, "meetPlace" text, "transportMode" text, "homeAway" text,
        opponent text, "responseMode" text, "dutyTypeId" uuid, needed integer)
      ORDER BY (i."parentItemId" IS NOT NULL), i.sort`);
  }
}

// --- Programmes -------------------------------------------------------------------

export interface ProgrammeRow {
  id: string;
  clubId: string;
  title: string;
  templateId: string | null;
  edition: string | null;
  eventId: string | null;
  firstDay: string;
  lastDay: string;
  groupIds: string[];
}

type ProgrammeDb = {
  id: string;
  club_id: string;
  title: string;
  template_id: string | null;
  edition: string | null;
  event_id: string | null;
  first_day: string;
  last_day: string;
  group_ids: string[];
};

const toProgramme = (r: ProgrammeDb): ProgrammeRow => ({
  id: r.id,
  clubId: r.club_id,
  title: r.title,
  templateId: r.template_id,
  edition: r.edition,
  eventId: r.event_id,
  firstDay: r.first_day,
  lastDay: r.last_day,
  groupIds: r.group_ids,
});

const PROGRAMME_SELECT = sql`
  SELECT p.id, p.club_id, p.title, p.template_id, p.edition, p.event_id,
    p.first_day::text AS first_day, p.last_day::text AS last_day,
    ARRAY(SELECT pg.group_id FROM public.programme_groups pg
      WHERE pg.programme_id = p.id ORDER BY pg.group_id) AS group_ids
  FROM public.programmes p`;

export async function programme(tx: Tx, id: string): Promise<ProgrammeRow | null> {
  const { rows } = await tx.execute<ProgrammeDb>(sql`${PROGRAMME_SELECT} WHERE p.id = ${id}::uuid`);
  return rows[0] ? toProgramme(rows[0]) : null;
}

export async function insertProgramme(
  tx: Tx,
  row: {
    id: string;
    clubId: string;
    title: string;
    templateId: string | null;
    edition: string | null;
    eventId: string | null;
    firstDay: string;
    lastDay: string;
    groupIds: readonly string[];
    by: string | null;
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO public.programmes (id, club_id, title, template_id, edition, event_id, first_day,
      last_day, created_by_person_id)
    VALUES (${row.id}, ${row.clubId}, ${row.title}, ${row.templateId}, ${row.edition},
      ${row.eventId}, ${row.firstDay}::date, ${row.lastDay}::date, ${row.by})`);
  if (row.groupIds.length > 0) {
    await tx.execute(sql`
      INSERT INTO public.programme_groups (programme_id, club_id, group_id)
      SELECT ${row.id}::uuid, ${row.clubId}::uuid, g
      FROM unnest(${uuidArray([...new Set(row.groupIds)])}::uuid[]) AS g`);
  }
}

export async function deleteProgramme(tx: Tx, id: string): Promise<void> {
  await tx.execute(sql`DELETE FROM public.programmes WHERE id = ${id}::uuid`);
}

/** The club's programmes (or a group's), from a day, by first day (keyset on the ID within it). */
export async function programmes(
  tx: Tx,
  filter: { groupId: string | null; from: string | null },
  page: { cursor: string | null; limit: number },
): Promise<ProgrammeRow[]> {
  const group = filter.groupId
    ? sql`AND EXISTS (SELECT 1 FROM public.programme_groups pg
        WHERE pg.programme_id = p.id AND pg.group_id = ${filter.groupId}::uuid)`
    : sql``;
  const after = page.cursor
    ? sql`AND (p.first_day, p.id) > (SELECT c.first_day, c.id FROM public.programmes c
        WHERE c.id = ${page.cursor}::uuid)`
    : sql``;
  const { rows } = await tx.execute<ProgrammeDb>(sql`
    ${PROGRAMME_SELECT}
    WHERE p.club_id = app.current_club_id()
      AND (${filter.from}::date IS NULL OR p.last_day >= ${filter.from}::date)
      ${group} ${after}
    ORDER BY p.first_day, p.id LIMIT ${page.limit}`);
  return rows.map(toProgramme);
}

/** Coming programmes of these groups (the caller's and their family's), soonest first. */
export async function programmesOfGroups(
  tx: Tx,
  groupIds: readonly string[],
  from: string,
  limit: number,
): Promise<ProgrammeRow[]> {
  if (groupIds.length === 0) return [];
  const { rows } = await tx.execute<ProgrammeDb>(sql`
    ${PROGRAMME_SELECT}
    WHERE p.id IN (SELECT pg.programme_id FROM public.programme_groups pg
        WHERE pg.group_id = ANY (${uuidArray([...new Set(groupIds)])}::uuid[]))
      AND p.last_day >= ${from}::date
    ORDER BY p.first_day, p.id LIMIT ${limit}`);
  return rows.map(toProgramme);
}

/** Programmes laid out from a template, newest first. */
export async function editions(
  tx: Tx,
  templateId: string,
): Promise<{ programmeId: string; title: string; edition: string | null; firstDay: string }[]> {
  const { rows } = await tx.execute<{
    id: string;
    title: string;
    edition: string | null;
    first_day: string;
  }>(sql`
    SELECT id, title, edition, first_day::text AS first_day FROM public.programmes
    WHERE template_id = ${templateId}::uuid ORDER BY first_day DESC, id DESC LIMIT 20`);
  return rows.map((r) => ({
    programmeId: r.id,
    title: r.title,
    edition: r.edition,
    firstDay: r.first_day,
  }));
}

/** The programme an event belongs to. */
export async function programmeOfEvent(tx: Tx, eventId: string): Promise<string | null> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT id FROM public.programmes WHERE event_id = ${eventId}::uuid`);
  return rows[0]?.id ?? null;
}
