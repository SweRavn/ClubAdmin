// SPDX-License-Identifier: AGPL-3.0-only
// The rules of templates and laying them out (P2.9, ADR 0054), apart from
// the database so that they are tested on their own:
// - a template from a source's activities and shifts: relative days and
//   wall-clock times in the club's time zone, one slot per group, no people;
// - checking a template's items (at most 300, days, slots, parents);
// - laying out on a first day: times through the club's time zone (09:00
//   stays 09:00 across daylight saving time), slots to groups, places
//   replaced, warnings (never blocking) and refusals.

import {
  type ActivityKind,
  type HomeAway,
  localDate,
  localTime,
  PROGRAMME_TEMPLATE_ITEMS_MAX,
  type ProgrammeEventSettings,
  type ProgrammeItemValues,
  type ProgrammeNotice,
  type ProgrammeSlot,
  type ResponseMode,
  type TransportMode,
  uuidv7,
  zonedTime,
} from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import type { StoredItem } from "./programmes.repository.ts";

const DAY_MS = 86_400_000;

/** The ISO date `n` days after `date`. */
export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Days from `from` to `to` (ISO dates). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/**
 * A local date and time in the zone as an instant; a time the spring change
 * skips becomes the same wall-clock time an hour later.
 */
export function instantOf(date: string, time: string, timeZone: string): Date {
  const at = zonedTime(date, time, timeZone);
  if (at) return at;
  const [h, m] = time.split(":").map(Number) as [number, number];
  const later = `${String((h + 1) % 24).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  return zonedTime(date, later, timeZone) ?? new Date(Date.parse(`${date}T${time}:00Z`));
}

// --- Templates from a source --------------------------------------------------------

export interface SourceActivity {
  id: string;
  kind: ActivityKind;
  kindLabel: string | null;
  title: string;
  notes: string | null;
  locationId: string | null;
  locationText: string | null;
  startsAt: Date;
  endsAt: Date;
  meetAt: Date | null;
  meetPlace: string | null;
  transportMode: TransportMode | null;
  homeAway: HomeAway | null;
  opponent: string | null;
  responseMode: ResponseMode;
  groupIds: readonly string[];
}

export interface SourceShift {
  id: string;
  groupId: string | null;
  dutyTypeId: string;
  title: string;
  note: string | null;
  startsAt: Date;
  endsAt: Date;
  locationId: string | null;
  needed: number;
  activityId: string | null;
}

export interface TemplateContent {
  dayCount: number;
  slots: ProgrammeSlot[];
  items: StoredItem[];
}

/**
 * A template of the source: the first local day is day 0; every group of
 * the items becomes a slot ("g1", "g2", … labelled with the group's name and
 * mapped to it by default). Nothing about people is read or kept: the
 * activities' notes are their public notes, not the leaders'.
 */
export function templateFromSource(
  source: { activities: readonly SourceActivity[]; shifts: readonly SourceShift[] },
  timeZone: string,
  groupNames: ReadonlyMap<string, string>,
): TemplateContent {
  const { activities, shifts } = source;
  if (activities.length + shifts.length === 0) throw new DomainError("programme_source_empty");
  if (activities.length + shifts.length > PROGRAMME_TEMPLATE_ITEMS_MAX) {
    throw new DomainError("programme_template_too_large");
  }
  const starts = [...activities, ...shifts].map((i) => localDate(i.startsAt, timeZone)).sort();
  const firstDay = starts[0]!;
  const slotOf = new Map<string, string>();
  const slots: ProgrammeSlot[] = [];
  const keyOf = (groupId: string): string => {
    let key = slotOf.get(groupId);
    if (!key) {
      key = `g${slotOf.size + 1}`;
      slotOf.set(groupId, key);
      slots.push({ key, label: groupNames.get(groupId) ?? key, defaultGroupId: groupId });
    }
    return key;
  };
  let lastOffset = 0;
  const when = (startsAt: Date, endsAt: Date) => {
    const dayOffset = daysBetween(firstDay, localDate(startsAt, timeZone));
    const endDayOffset = daysBetween(firstDay, localDate(endsAt, timeZone));
    if (endDayOffset > 30) throw new DomainError("programme_day_offset_invalid");
    lastOffset = Math.max(lastOffset, endDayOffset);
    return {
      dayOffset,
      startTime: localTime(startsAt, timeZone),
      endDayOffset,
      endTime: localTime(endsAt, timeZone),
    };
  };
  const itemOfActivity = new Map<string, string>();
  const items: StoredItem[] = [];
  for (const a of [...activities].sort((x, y) => x.startsAt.getTime() - y.startsAt.getTime())) {
    const id = uuidv7();
    itemOfActivity.set(a.id, id);
    items.push({
      id,
      kind: "activity",
      parentItemId: null,
      ...when(a.startsAt, a.endsAt),
      slotKeys: a.groupIds.map(keyOf),
      title: a.title,
      activityKind: a.kind,
      kindLabel: a.kind === "other" ? a.kindLabel : null,
      notes: a.notes,
      locationId: a.locationId,
      locationText: a.locationId ? null : a.locationText,
      meetMinutesBefore: a.meetAt
        ? Math.max(
            0,
            Math.min(600, Math.round((a.startsAt.getTime() - a.meetAt.getTime()) / 60_000)),
          )
        : null,
      meetPlace: a.meetPlace,
      transportMode: a.transportMode,
      homeAway: a.homeAway,
      opponent: a.opponent,
      responseMode: a.responseMode,
      dutyTypeId: null,
      needed: null,
    });
  }
  for (const s of [...shifts].sort((x, y) => x.startsAt.getTime() - y.startsAt.getTime())) {
    items.push({
      id: uuidv7(),
      kind: "duty_shift",
      parentItemId: (s.activityId && itemOfActivity.get(s.activityId)) || null,
      ...when(s.startsAt, s.endsAt),
      slotKeys: s.groupId ? [keyOf(s.groupId)] : [],
      title: s.title,
      activityKind: null,
      kindLabel: null,
      notes: s.note,
      locationId: s.locationId,
      locationText: null,
      meetMinutesBefore: null,
      meetPlace: null,
      transportMode: null,
      homeAway: null,
      opponent: null,
      responseMode: null,
      dutyTypeId: s.dutyTypeId,
      needed: s.needed,
    });
  }
  return { dayCount: lastOffset + 1, slots, items };
}

// --- Checking a template's items ------------------------------------------------------

/**
 * The items of a template change (the editor), with new IDs and parents
 * resolved from `ref`/`parentRef`; refuses what the database would.
 */
export function storedItemsOf(
  input: readonly ProgrammeItemValues[],
  slots: readonly ProgrammeSlot[],
  dayCount: number,
): StoredItem[] {
  if (input.length > PROGRAMME_TEMPLATE_ITEMS_MAX) {
    throw new DomainError("programme_template_too_large");
  }
  const keys = new Set(slots.map((s) => s.key));
  if (keys.size !== slots.length) throw new DomainError("invalid_input");
  const idOf = new Map<string, string>();
  for (const item of input) {
    if (idOf.has(item.ref)) throw new DomainError("invalid_input");
    idOf.set(item.ref, uuidv7());
  }
  const kindOf = new Map(input.map((i) => [i.ref, i.kind]));
  return input.map((item) => {
    if (item.endDayOffset >= dayCount || item.dayOffset > item.endDayOffset) {
      throw new DomainError("programme_day_offset_invalid");
    }
    if (item.dayOffset === item.endDayOffset && item.endTime <= item.startTime) {
      throw new DomainError("event_period_invalid");
    }
    if (item.slotKeys.some((k) => !keys.has(k))) throw new DomainError("programme_slot_unknown");
    let parentItemId: string | null = null;
    if (item.kind === "activity") {
      if (!item.activityKind || item.parentRef) throw new DomainError("invalid_input");
    } else {
      if (!item.dutyTypeId || !item.needed) throw new DomainError("invalid_input");
      if (item.parentRef) {
        if (kindOf.get(item.parentRef) !== "activity") throw new DomainError("invalid_input");
        parentItemId = idOf.get(item.parentRef)!;
      }
    }
    const { ref: _ref, parentRef: _parent, ...rest } = item;
    return {
      ...rest,
      id: idOf.get(item.ref)!,
      parentItemId,
      kindLabel: item.activityKind === "other" ? item.kindLabel : null,
      responseMode: item.kind === "activity" ? (item.responseMode ?? "none") : null,
      activityKind: item.kind === "activity" ? item.activityKind : null,
      dutyTypeId: item.kind === "duty_shift" ? item.dutyTypeId : null,
      needed: item.kind === "duty_shift" ? item.needed : null,
      locationText: item.locationId ? null : item.locationText,
    };
  });
}

// --- Laying out ---------------------------------------------------------------------

export interface LaidOutItem {
  /** The template item. */
  itemId: string;
  /** The new activity's or shift's ID. */
  newId: string;
  kind: "activity" | "duty_shift";
  parentItemId: string | null;
  title: string;
  activityKind: ActivityKind | null;
  kindLabel: string | null;
  startsAt: Date;
  endsAt: Date;
  meetAt: Date | null;
  groupIds: string[];
  locationId: string | null;
  locationText: string | null;
  dutyTypeId: string | null;
  needed: number | null;
  source: StoredItem;
}

export interface Layout {
  firstDay: string;
  lastDay: string;
  items: LaidOutItem[];
  slots: { key: string; label: string; groupIds: string[] }[];
  groupIds: string[];
  event: { startsAt: Date; endsAt: Date; opensAt: Date | null; closesAt: Date } | null;
  warnings: ProgrammeNotice[];
  refusals: ProgrammeNotice[];
}

export interface LayoutFacts {
  timeZone: string;
  now: Date;
  /** The club's groups among those mapped (missing: not the club's). */
  groups: ReadonlyMap<string, { archived: boolean }>;
  /** The places used after mapping (missing: not the club's). */
  locations: ReadonlyMap<string, { archived: boolean }>;
  /** Why a duty type cannot be laid out. */
  dutyRefusals: ReadonlyMap<string, string>;
  /** Scheduled activities at the places in the programme's days. */
  existing: readonly { id: string; locationId: string; startsAt: Date; endsAt: Date }[];
}

const notice = (code: string, at: Partial<ProgrammeNotice> = {}): ProgrammeNotice => ({
  code,
  itemId: at.itemId ?? null,
  slotKey: at.slotKey ?? null,
  groupId: at.groupId ?? null,
  locationId: at.locationId ?? null,
  activityId: at.activityId ?? null,
});

/** The groups each slot maps to: as asked, else the default group if it may be used. */
export function slotMapping(
  slots: readonly ProgrammeSlot[],
  asked: Readonly<Record<string, readonly string[]>>,
  usable: (groupId: string) => boolean,
): Map<string, string[]> {
  return new Map(
    slots.map((s) => [
      s.key,
      s.key in asked
        ? [...new Set(asked[s.key])]
        : s.defaultGroupId && usable(s.defaultGroupId)
          ? [s.defaultGroupId]
          : [],
    ]),
  );
}

/**
 * The template on the first day: every item's time, groups and place, the
 * warnings and the refusals. Nothing is written.
 */
export function layOut(
  template: { dayCount: number; slots: readonly ProgrammeSlot[]; items: readonly StoredItem[] },
  eventSettings: ProgrammeEventSettings | null,
  input: {
    firstDay: string;
    slots: ReadonlyMap<string, readonly string[]>;
    locations: Readonly<Record<string, string>>;
  },
  facts: LayoutFacts,
): Layout {
  const { timeZone } = facts;
  const warnings: ProgrammeNotice[] = [];
  const refusals: ProgrammeNotice[] = [];
  const groupsOfSlot = (key: string) => input.slots.get(key) ?? [];
  for (const slot of template.slots) {
    if (groupsOfSlot(slot.key).length === 0) {
      warnings.push(notice("slot_without_group", { slotKey: slot.key }));
    }
    for (const groupId of groupsOfSlot(slot.key)) {
      const group = facts.groups.get(groupId);
      if (!group) refusals.push(notice("group_not_found", { slotKey: slot.key, groupId }));
      else if (group.archived)
        refusals.push(notice("group_archived", { slotKey: slot.key, groupId }));
    }
  }
  const placeOf = (id: string | null) => (id ? (input.locations[id] ?? id) : null);
  const byItem = new Map<string, LaidOutItem>();
  const items: LaidOutItem[] = [];
  let lastDay = input.firstDay;
  for (const item of template.items) {
    const startsAt = instantOf(addDays(input.firstDay, item.dayOffset), item.startTime, timeZone);
    let endsAt = instantOf(addDays(input.firstDay, item.endDayOffset), item.endTime, timeZone);
    if (endsAt <= startsAt) endsAt = new Date(startsAt.getTime() + 60_000);
    const end = addDays(input.firstDay, item.endDayOffset);
    if (end > lastDay) lastDay = end;
    const own = [...new Set(item.slotKeys.flatMap(groupsOfSlot))];
    const parent = item.parentItemId ? byItem.get(item.parentItemId) : undefined;
    const groupIds =
      item.kind === "activity"
        ? own
        : own.length > 0
          ? [own[0]!]
          : parent
            ? parent.groupIds.slice(0, 1)
            : [];
    const laid: LaidOutItem = {
      itemId: item.id,
      newId: uuidv7(),
      kind: item.kind,
      parentItemId: item.parentItemId,
      title: item.title,
      activityKind: item.activityKind,
      kindLabel: item.kindLabel,
      startsAt,
      endsAt,
      meetAt:
        item.meetMinutesBefore === null
          ? null
          : new Date(startsAt.getTime() - item.meetMinutesBefore * 60_000),
      groupIds,
      locationId: placeOf(item.locationId),
      locationText: item.locationId ? null : item.locationText,
      dutyTypeId: item.dutyTypeId,
      needed: item.needed,
      source: item,
    };
    byItem.set(item.id, laid);
    items.push(laid);
    if (item.kind === "activity" && groupIds.length === 0) {
      refusals.push(notice("activity_without_group", { itemId: item.id }));
    }
    if (item.kind === "duty_shift" && groupIds.length === 0 && item.slotKeys.length > 0) {
      warnings.push(notice("item_without_group", { itemId: item.id }));
    }
    if (laid.locationId) {
      const place = facts.locations.get(laid.locationId);
      if (!place)
        refusals.push(
          notice("location_archived", { itemId: item.id, locationId: laid.locationId }),
        );
      else if (place.archived) {
        refusals.push(
          notice("location_archived", { itemId: item.id, locationId: laid.locationId }),
        );
      }
    }
    if (item.dutyTypeId) {
      const code = facts.dutyRefusals.get(item.dutyTypeId);
      if (code)
        refusals.push(
          notice(code === "not_found" ? "duty_type_archived" : code, { itemId: item.id }),
        );
    }
  }
  if (items.some((i) => i.startsAt < facts.now)) warnings.push(notice("past_date"));
  // Location conflicts: with the club's activities, and within the programme.
  const placed = items.filter((i) => i.kind === "activity" && i.locationId);
  for (const [n, a] of placed.entries()) {
    for (const e of facts.existing) {
      if (e.locationId === a.locationId && e.startsAt < a.endsAt && e.endsAt > a.startsAt) {
        warnings.push(
          notice("location_conflict", {
            itemId: a.itemId,
            locationId: a.locationId,
            activityId: e.id,
          }),
        );
      }
    }
    for (const b of placed.slice(n + 1)) {
      if (b.locationId === a.locationId && b.startsAt < a.endsAt && b.endsAt > a.startsAt) {
        warnings.push(notice("location_conflict", { itemId: b.itemId, locationId: b.locationId }));
      }
    }
  }
  const groupIds = [...new Set(items.flatMap((i) => i.groupIds))];
  let event: Layout["event"] = null;
  const activities = items.filter((i) => i.kind === "activity");
  if (eventSettings && activities.length > 0) {
    const startsAt = new Date(Math.min(...activities.map((a) => a.startsAt.getTime())));
    const endsAt = new Date(Math.max(...activities.map((a) => a.endsAt.getTime())));
    const opensAt =
      eventSettings.opensDaysBefore === null
        ? null
        : instantOf(addDays(input.firstDay, -eventSettings.opensDaysBefore), "00:00", timeZone);
    const closing =
      eventSettings.closesDaysBefore === null
        ? startsAt
        : instantOf(addDays(input.firstDay, -eventSettings.closesDaysBefore), "23:59", timeZone);
    const closesAt = closing > endsAt ? endsAt : closing;
    event = { startsAt, endsAt, opensAt: opensAt && opensAt < closesAt ? opensAt : null, closesAt };
    if (eventSettings.audience === "groups" && groupIds.length === 0) {
      refusals.push(notice("activity_without_group"));
    }
  }
  return {
    firstDay: input.firstDay,
    lastDay,
    items,
    slots: template.slots.map((s) => ({
      key: s.key,
      label: s.label,
      groupIds: [...groupsOfSlot(s.key)],
    })),
    groupIds,
    event,
    warnings,
    refusals,
  };
}
