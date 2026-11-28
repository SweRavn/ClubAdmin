// SPDX-License-Identifier: AGPL-3.0-only
// Programmes and templates (P2.9, ADR 0054). A programme groups activities
// and duty shifts; a template is a snapshot of a source without people;
// laying out is a preview, then one transaction through the activities,
// duties and events services (their rules, audit, history and notices),
// all or nothing, with bulk inserts (a constant number of statements per
// kind of item, ADR 0040). Who may use which groups is checked by the
// controller before (`requirements`), as for events.

import { audit, type Database, type TenantContext, type Tx } from "@clubadmin/db";
import {
  type ApplyProgrammeInput,
  ApplyProgrammeSchema,
  type CopyProgrammeInput,
  CopyProgrammeSchema,
  type CreateProgrammeTemplateInput,
  CreateProgrammeTemplateSchema,
  localDate,
  PROGRAMME_RANGE_DAYS_MAX,
  type ProgrammeEventSettings,
  ProgrammeEventSettingsSchema,
  type ProgrammeSlot,
  type ProgrammeTemplateSource,
  type ProgrammeTimeline,
  type UpdateProgrammeTemplateInput,
  UpdateProgrammeTemplateSchema,
  uuidv7,
} from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { actorPersonId, parseInput } from "../../platform/domain/run.ts";
import type { ActivitiesService } from "../activities/index.ts";
import type { CarpoolsService } from "../carpools/index.ts";
import type { ClubsService } from "../clubs/index.ts";
import type { DutiesService, ShiftRow } from "../duties/index.ts";
import type { EventsService } from "../events/index.ts";
import {
  addDays,
  daysBetween,
  instantOf,
  type Layout,
  layOut,
  slotMapping,
  type SourceActivity,
  type SourceShift,
  storedItemsOf,
  type TemplateContent,
  templateFromSource,
} from "./programmes.layout.ts";
import * as repo from "./programmes.repository.ts";

export type { Layout } from "./programmes.layout.ts";
export type { ProgrammeRow, StoredItem, TemplateRow } from "./programmes.repository.ts";

export interface ProgrammesDeps {
  clubs: ClubsService;
  activities: ActivitiesService;
  duties: DutiesService;
  events: EventsService;
  carpools: CarpoolsService;
  now?: () => Date;
}

/** What laying out needs the caller to be allowed (checked per group by the controller). */
export interface LayoutRequirements {
  groupIds: string[];
  shifts: boolean;
  event: boolean;
}

/** A template in memory: stored, or made on the fly from a programme (copying). */
interface TemplateSnapshot extends TemplateContent {
  templateId: string | null;
  name: string;
  eventSettings: ProgrammeEventSettings | null;
}

export class ProgrammesService {
  private readonly db: Database;
  private readonly deps: ProgrammesDeps;
  private readonly now: () => Date;

  constructor(db: Database, deps: ProgrammesDeps) {
    this.db = db;
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  // --- Templates ------------------------------------------------------------------

  listTemplates(
    context: TenantContext,
    filter: { groupIds: readonly string[] | null; archived: boolean },
    page: { cursor: string | null; limit: number },
  ): Promise<{ items: repo.TemplateRow[]; nextCursor: string | null }> {
    return this.db.withTenant(context, async (tx) => {
      const rows = await repo.templates(tx, filter, { ...page, limit: page.limit + 1 });
      const items = rows.slice(0, page.limit);
      return { items, nextCursor: rows.length > page.limit ? items.at(-1)!.id : null };
    });
  }

  getTemplate(
    context: TenantContext,
    templateId: string,
  ): Promise<{
    template: repo.TemplateRow;
    slots: ProgrammeSlot[];
    items: repo.StoredItem[];
    editions: Awaited<ReturnType<typeof repo.editions>>;
  }> {
    return this.db.withTenant(context, async (tx) => {
      const template = await repo.template(tx, templateId);
      if (!template) throw new DomainError("not_found");
      return {
        template,
        slots: await repo.slots(tx, templateId),
        items: await repo.items(tx, templateId),
        editions: await repo.editions(tx, templateId),
      };
    });
  }

  /** The groups of a source (to check the caller may use it before saving it as a template). */
  sourceGroups(context: TenantContext, source: ProgrammeTemplateSource): Promise<string[]> {
    if ("empty" in source) return Promise.resolve([]);
    return this.db.withTenant(context, async (tx) => {
      const loaded = await this.loadSource(tx, context, source);
      return [
        ...new Set([
          ...loaded.activities.flatMap((a) => a.groupIds),
          ...loaded.shifts.flatMap((s) => (s.groupId ? [s.groupId] : [])),
        ]),
      ];
    });
  }

  /** A template saved from a source: a snapshot without people (decision 8). */
  createTemplate(
    context: TenantContext,
    input: CreateProgrammeTemplateInput,
  ): Promise<{ id: string }> {
    const data = parseInput(CreateProgrammeTemplateSchema, input);
    return this.db.withTenant(context, async (tx) => {
      if (data.groupId) {
        const [group] = await this.deps.activities.clubGroupsInTx(tx, context.clubId, [
          data.groupId,
        ]);
        if (!group) throw new DomainError("not_found");
        if (group.archived) throw new DomainError("group_archived");
      }
      const club = await this.deps.clubs.getClubInTx(tx, context.clubId);
      if ("empty" in data.source) {
        const id = uuidv7();
        await repo.insertTemplate(tx, {
          id,
          clubId: context.clubId,
          groupId: data.groupId,
          name: data.name,
          description: data.description ?? null,
          dayCount: 1,
          eventSettings: null,
          by: actorPersonId(context),
        });
        await repo.replaceContent(tx, context.clubId, id, {
          slots: [{ key: "g1", label: "Lag 1", defaultGroupId: data.groupId }],
          items: [],
        });
        await audit.record(tx, {
          action: "programme.template.created",
          resourceType: "programme_template",
          resourceId: id,
        });
        return { id };
      }
      const loaded = await this.loadSource(tx, context, data.source);
      const groupIds = [
        ...new Set([
          ...loaded.activities.flatMap((a) => a.groupIds),
          ...loaded.shifts.flatMap((s) => (s.groupId ? [s.groupId] : [])),
        ]),
      ];
      const names = await this.deps.activities.groupNamesInTx(tx, context.clubId, groupIds);
      const content = templateFromSource(loaded, club.timeZone, names);
      const id = uuidv7();
      await repo.insertTemplate(tx, {
        id,
        clubId: context.clubId,
        groupId: data.groupId,
        name: data.name,
        description: data.description ?? null,
        dayCount: content.dayCount,
        eventSettings: loaded.eventSettings,
        by: actorPersonId(context),
      });
      await repo.replaceContent(tx, context.clubId, id, content);
      await audit.record(tx, {
        action: "programme.template.created",
        resourceType: "programme_template",
        resourceId: id,
      });
      return { id };
    });
  }

  updateTemplate(
    context: TenantContext,
    templateId: string,
    input: UpdateProgrammeTemplateInput,
  ): Promise<void> {
    const data = parseInput(UpdateProgrammeTemplateSchema, input);
    return this.db.withTenant(context, async (tx) => {
      const current = await repo.template(tx, templateId, true);
      if (!current) throw new DomainError("not_found");
      const dayCount = data.dayCount ?? current.dayCount;
      const slots = data.slots ?? (await repo.slots(tx, templateId));
      if (data.slots) {
        const groupIds = data.slots.flatMap((s) => (s.defaultGroupId ? [s.defaultGroupId] : []));
        const found = await this.deps.activities.clubGroupsInTx(tx, context.clubId, groupIds);
        if (found.length !== new Set(groupIds).size) throw new DomainError("not_found");
      }
      if (data.items || data.slots || data.dayCount) {
        const items = data.items
          ? storedItemsOf(data.items, slots, dayCount)
          : storedItemsOf(
              (await repo.items(tx, templateId)).map((i) => ({
                ...i,
                ref: i.id,
                parentRef: i.parentItemId,
              })),
              slots,
              dayCount,
            );
        await this.requireItemReferences(tx, context.clubId, items);
        await repo.replaceContent(tx, context.clubId, templateId, { slots, items });
      }
      await repo.updateTemplate(tx, templateId, {
        name: data.name ?? current.name,
        description: data.description === undefined ? current.description : data.description,
        dayCount,
        eventSettings:
          data.eventSettings === undefined ? current.eventSettings : data.eventSettings,
        archived: data.archived ?? current.archived,
      });
      await audit.record(tx, {
        action:
          data.archived === true && !current.archived
            ? "programme.template.archived"
            : "programme.template.updated",
        resourceType: "programme_template",
        resourceId: templateId,
        changedFields: Object.keys(data),
      });
    });
  }

  // --- Laying out -----------------------------------------------------------------

  /** The groups laying out would use, and whether it has shifts and an event. */
  requirements(
    context: TenantContext,
    from: { templateId: string } | { programmeId: string },
    input: ApplyProgrammeInput | CopyProgrammeInput,
  ): Promise<LayoutRequirements> {
    return this.db.withTenant(context, async (tx) => {
      const snapshot = await this.snapshot(tx, context, from);
      const asked = input.slots ?? {};
      const defaults = snapshot.slots.flatMap((s) => (s.defaultGroupId ? [s.defaultGroupId] : []));
      const usable = new Set(
        (await this.deps.activities.clubGroupsInTx(tx, context.clubId, defaults))
          .filter((g) => !g.archived)
          .map((g) => g.id),
      );
      const mapping = slotMapping(snapshot.slots, asked, (id) => usable.has(id));
      return {
        groupIds: [...new Set([...mapping.values()].flat())],
        shifts: snapshot.items.some((i) => i.kind === "duty_shift"),
        event: snapshot.eventSettings !== null,
      };
    });
  }

  /** The preview (decision 9): writes nothing. */
  preview(
    context: TenantContext,
    from: { templateId: string } | { programmeId: string },
    input: ApplyProgrammeInput | CopyProgrammeInput,
  ): Promise<{
    layout: Layout;
    title: string;
    edition: string | null;
    timeZone: string;
    snapshot: { eventSettings: ProgrammeEventSettings | null };
  }> {
    return this.db.withTenant(context, async (tx) => {
      const { layout, snapshot, timeZone } = await this.layout(tx, context, from, input);
      return {
        layout,
        title: this.titleOf(snapshot, input),
        edition: "templateId" in from ? this.editionOf(input, layout) : null,
        timeZone,
        snapshot: { eventSettings: snapshot.eventSettings },
      };
    });
  }

  /**
   * Lays out in one transaction: the programme, its groups, the event as a
   * draft, the activities and the shifts, or nothing (any refusal).
   */
  apply(
    context: TenantContext,
    from: { templateId: string } | { programmeId: string },
    input: ApplyProgrammeInput | CopyProgrammeInput,
  ): Promise<{
    programme: repo.ProgrammeRow;
    groupNames: Map<string, string>;
    activities: number;
    dutyShifts: number;
  }> {
    return this.db.withTenant(context, async (tx) => {
      const { layout, snapshot, timeZone } = await this.layout(tx, context, from, input);
      const refusal = layout.refusals[0];
      if (refusal) {
        throw new DomainError(
          refusal.code === "location_archived"
            ? "programme_location_archived"
            : refusal.code === "duty_type_archived"
              ? "programme_duty_type_archived"
              : refusal.code === "activity_without_group"
                ? "programme_slot_unmapped"
                : refusal.code === "duty_alone_with_children_forbidden"
                  ? "duty_alone_with_children_forbidden"
                  : "programme_group_unavailable",
        );
      }
      const title = this.titleOf(snapshot, input);
      const activities = layout.items.filter((i) => i.kind === "activity");
      const shifts = layout.items.filter((i) => i.kind === "duty_shift");
      let eventId: string | null = null;
      const settings = snapshot.eventSettings;
      if (settings && layout.event) {
        const audienceGroups = settings.audience === "groups" ? layout.groupIds : [];
        const event = await this.deps.events.createEventInTx(tx, context, {
          title: settings.title,
          description: settings.description,
          audience: settings.audience,
          groupIds: audienceGroups,
          startsAt: layout.event.startsAt.toISOString(),
          endsAt: layout.event.endsAt.toISOString(),
          registrationOpensAt: layout.event.opensAt?.toISOString() ?? null,
          registrationClosesAt: layout.event.closesAt.toISOString(),
          capacity: settings.capacity,
          ...(settings.waitlistMode ? { waitlistMode: settings.waitlistMode } : {}),
          questions: settings.questions,
          priceText: settings.priceText,
          publish: false,
        });
        eventId = event.event.id;
      }
      const programmeId = uuidv7();
      await repo.insertProgramme(tx, {
        id: programmeId,
        clubId: context.clubId,
        title,
        templateId: snapshot.templateId,
        edition: "templateId" in from ? this.editionOf(input, layout) : null,
        eventId,
        firstDay: layout.firstDay,
        lastDay: layout.lastDay,
        groupIds: layout.groupIds,
        by: actorPersonId(context),
      });
      const ids = await this.deps.activities.createProgrammeActivitiesInTx(
        tx,
        context,
        programmeId,
        activities.map((a) => ({
          id: a.newId,
          groupIds: a.groupIds,
          kind: a.activityKind!,
          kindLabel: a.kindLabel,
          title: a.title,
          notes: a.source.notes,
          locationId: a.locationId,
          locationText: a.locationText,
          startsAt: a.startsAt,
          endsAt: a.endsAt,
          meetAt: a.meetAt,
          meetPlace: a.source.meetPlace,
          transportMode: a.source.transportMode,
          homeAway: a.source.homeAway,
          opponent: a.source.opponent,
          responseMode: a.source.responseMode,
          inviteesOnly: eventId !== null,
        })),
      );
      if (eventId) {
        await this.deps.events.linkProgrammeActivitiesInTx(tx, context.clubId, eventId, ids);
      }
      const newIdOf = new Map(layout.items.map((i) => [i.itemId, i.newId]));
      await this.deps.duties.createProgrammeShiftsInTx(
        tx,
        context,
        programmeId,
        shifts.map((s) => ({
          id: s.newId,
          groupId: s.groupIds[0] ?? null,
          dutyTypeId: s.dutyTypeId!,
          title: s.title,
          note: s.source.notes,
          startsAt: s.startsAt,
          endsAt: s.endsAt,
          locationId: s.locationId,
          needed: s.needed ?? 1,
          activityId: s.parentItemId ? (newIdOf.get(s.parentItemId) ?? null) : null,
          eventId: s.parentItemId ? null : eventId,
        })),
      );
      await audit.record(tx, {
        action: "programme.applied",
        resourceType: "programme",
        resourceId: programmeId,
        changedFields: [
          ...(activities.length > 0 ? ["activities"] : []),
          ...(shifts.length > 0 ? ["duty_shifts"] : []),
          ...(eventId ? ["event"] : []),
        ],
      });
      void timeZone;
      const programme = (await repo.programme(tx, programmeId))!;
      return {
        programme,
        groupNames: await this.groupNames(tx, context.clubId, [programme]),
        activities: activities.length,
        dutyShifts: shifts.length,
      };
    });
  }

  // --- Programmes -----------------------------------------------------------------

  /**
   * The event's programme (decision 1): made when its organiser opens the
   * programme view, holding the event's sessions and their and its shifts.
   */
  ensureEventProgramme(
    context: TenantContext,
    eventId: string,
  ): Promise<{ programme: repo.ProgrammeRow; groupNames: Map<string, string> }> {
    return this.db.withTenant(context, async (tx) => {
      const existing = await repo.programmeOfEvent(tx, eventId);
      if (!existing) {
        const found = await this.deps.events.eventForTemplateInTx(tx, eventId);
        if (!found) throw new DomainError("not_found");
        const club = await this.deps.clubs.getClubInTx(tx, context.clubId);
        const rows = await this.deps.activities.activitiesInTx(tx, found.activityIds);
        const shifts = [
          ...(await this.deps.duties.shiftsOfInTx(tx, { activityIds: found.activityIds })),
          ...(await this.deps.duties.shiftsOfInTx(tx, { eventId })),
        ];
        const instants = [
          found.event.startsAt,
          found.event.endsAt,
          ...rows.flatMap((r) => [r.startsAt, r.endsAt]),
        ];
        const days = instants.map((d) => localDate(d, club.timeZone)).sort();
        const id = uuidv7();
        const groupsOf = await this.deps.activities.groupsOfActivitiesInTx(
          tx,
          rows.map((r) => r.id),
        );
        const groupIds = [
          ...new Set([...found.groupIds, ...[...groupsOf.values()].flat().map((g) => g.id)]),
        ];
        await repo.insertProgramme(tx, {
          id,
          clubId: context.clubId,
          title: found.event.title,
          templateId: null,
          edition: null,
          eventId,
          firstDay: days[0]!,
          lastDay: days.at(-1)!,
          groupIds,
          by: actorPersonId(context),
        });
        await this.deps.activities.assignProgrammeInTx(
          tx,
          id,
          rows.map((r) => r.id),
        );
        await this.deps.duties.assignProgrammeInTx(
          tx,
          id,
          shifts.map((s) => s.id),
        );
        await audit.record(tx, {
          action: "programme.created",
          resourceType: "programme",
          resourceId: id,
        });
      }
      const programmeId = existing ?? (await repo.programmeOfEvent(tx, eventId))!;
      const programme = (await repo.programme(tx, programmeId))!;
      return { programme, groupNames: await this.groupNames(tx, context.clubId, [programme]) };
    });
  }

  listProgrammes(
    context: TenantContext,
    filter: { groupId: string | null; from: string | null },
    page: { cursor: string | null; limit: number },
  ): Promise<{
    items: repo.ProgrammeRow[];
    groupNames: Map<string, string>;
    nextCursor: string | null;
  }> {
    return this.db.withTenant(context, async (tx) => {
      const rows = await repo.programmes(tx, filter, { ...page, limit: page.limit + 1 });
      const items = rows.slice(0, page.limit);
      return {
        items,
        groupNames: await this.groupNames(tx, context.clubId, items),
        nextCursor: rows.length > page.limit ? items.at(-1)!.id : null,
      };
    });
  }

  /** Coming programmes of these groups (the caller's and their family's), at most 20. */
  programmesOfGroups(
    context: TenantContext,
    groupIds: readonly string[],
  ): Promise<{ items: repo.ProgrammeRow[]; groupNames: Map<string, string> }> {
    return this.db.withTenant(context, async (tx) => {
      const club = await this.deps.clubs.getClubInTx(tx, context.clubId);
      const today = localDate(this.now(), club.timeZone);
      const items = await repo.programmesOfGroups(tx, groupIds, today, 20);
      return { items, groupNames: await this.groupNames(tx, context.clubId, items) };
    });
  }

  /** The programme, its days and places, and whether nothing is touched yet. */
  getProgramme(
    context: TenantContext,
    programmeId: string,
  ): Promise<{
    programme: repo.ProgrammeRow;
    groupNames: Map<string, string>;
    timeZone: string;
    days: string[];
    places: { locationId: string | null; name: string | null }[];
    untouched: boolean;
  }> {
    return this.db.withTenant(context, async (tx) => {
      const programme = await repo.programme(tx, programmeId);
      if (!programme) throw new DomainError("not_found");
      const club = await this.deps.clubs.getClubInTx(tx, context.clubId);
      const activities = await this.deps.activities.programmeActivitiesInTx(tx, programmeId);
      const shifts = await this.deps.duties.shiftsOfInTx(tx, { programmeId, range: null });
      const locationIds = [
        ...new Set([...activities, ...shifts].flatMap((i) => (i.locationId ? [i.locationId] : []))),
      ];
      const locations = await this.deps.activities.findLocationsInTx(tx, locationIds);
      const names = new Map(locations.map((l) => [l.id, l.name]));
      const places = [
        ...locationIds
          .map((id) => ({ locationId: id, name: names.get(id) ?? null }))
          .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
        ...([...activities, ...shifts].some((i) => !i.locationId)
          ? [{ locationId: null, name: null }]
          : []),
      ];
      const days: string[] = [];
      for (let d = programme.firstDay; d <= programme.lastDay; d = addDays(d, 1)) days.push(d);
      return {
        programme,
        groupNames: await this.groupNames(tx, context.clubId, [programme]),
        timeZone: club.timeZone,
        days,
        places,
        untouched: await this.untouched(tx, programme, activities, shifts),
      };
    });
  }

  /**
   * One day of the programme: its activities and shifts from the
   * (programme_id, starts_at) indexes. `visibleGroupIds` null: everything
   * (organisers, with conflicts); else only activities of these groups and
   * the shifts of their activities, the club's and the family's own.
   */
  timeline(
    context: TenantContext,
    programmeId: string,
    day: string,
    viewer: { organiser: boolean; visibleGroupIds: ReadonlySet<string>; family: readonly string[] },
  ): Promise<{
    activities: (ProgrammeTimeline["activities"][number] & { groupIds: string[] })[];
    shifts: ProgrammeTimeline["shifts"];
  }> {
    return this.db.withTenant(context, async (tx) => {
      const programme = await repo.programme(tx, programmeId);
      if (!programme) throw new DomainError("not_found");
      const club = await this.deps.clubs.getClubInTx(tx, context.clubId);
      const range = {
        from: instantOf(day, "00:00", club.timeZone),
        to: instantOf(addDays(day, 1), "00:00", club.timeZone),
      };
      const rows = await this.deps.activities.programmeActivitiesInTx(tx, programmeId, range);
      const groupsOf = await this.deps.activities.groupsOfActivitiesInTx(
        tx,
        rows.map((r) => r.id),
      );
      const visible = rows.filter(
        (r) =>
          viewer.organiser ||
          (groupsOf.get(r.id) ?? []).some((g) => viewer.visibleGroupIds.has(g.id)),
      );
      let conflicts = new Set<string>();
      if (viewer.organiser) {
        const placed = visible.filter((a) => a.locationId && a.status === "scheduled");
        const existing = await this.deps.activities.activitiesAtLocationsInTx(
          tx,
          context.clubId,
          [...new Set(placed.map((a) => a.locationId!))],
          range,
        );
        conflicts = new Set(
          placed
            .filter((a) =>
              existing.some(
                (e) =>
                  e.id !== a.id &&
                  e.locationId === a.locationId &&
                  e.startsAt < a.endsAt &&
                  e.endsAt > a.startsAt,
              ),
            )
            .map((a) => a.id),
        );
      }
      const shiftRows = (await this.deps.duties.shiftsOfInTx(tx, { programmeId, range })).filter(
        (s) =>
          viewer.organiser ||
          (s.activityId !== null && visible.some((a) => a.id === s.activityId)) ||
          (s.groupId !== null && viewer.visibleGroupIds.has(s.groupId)) ||
          s.groupId === null,
      );
      const assignments = await this.deps.duties.assignmentsInTx(
        tx,
        shiftRows.map((s) => s.id),
      );
      const family = new Set(viewer.family);
      const active = (a: { status: string }) => a.status !== "cancelled" && a.status !== "declined";
      return {
        activities: visible.map((a) => {
          const groups = groupsOf.get(a.id) ?? [];
          return {
            id: a.id,
            kind: a.kind,
            kindLabel: a.kindLabel,
            title: a.title,
            status: a.status,
            startsAt: a.startsAt.toISOString(),
            endsAt: a.endsAt.toISOString(),
            locationId: a.locationId,
            locationText: a.locationText,
            groups,
            groupIds: groups.map((g) => g.id),
            conflict: conflicts.has(a.id),
          };
        }),
        shifts: shiftRows.map((s: ShiftRow) => {
          const mine = assignments.filter((x) => x.shiftId === s.id && active(x));
          return {
            id: s.id,
            title: s.title,
            startsAt: s.startsAt.toISOString(),
            endsAt: s.endsAt.toISOString(),
            activityId: s.activityId,
            locationId: s.locationId,
            needed: s.needed,
            filled: mine.length,
            mine: mine.some(
              (x) =>
                family.has(x.personId) ||
                (x.countsForPersonId !== null && family.has(x.countsForPersonId)),
            ),
          };
        }),
      };
    });
  }

  /** Removes the programme with all its items, only while untouched (decision 11). */
  deleteProgramme(context: TenantContext, programmeId: string): Promise<void> {
    return this.db.withTenant(context, async (tx) => {
      const programme = await repo.programme(tx, programmeId);
      if (!programme) throw new DomainError("not_found");
      const activities = await this.deps.activities.programmeActivitiesInTx(tx, programmeId);
      const shifts = await this.deps.duties.shiftsOfInTx(tx, { programmeId, range: null });
      if (!(await this.untouched(tx, programme, activities, shifts))) {
        throw new DomainError("programme_not_untouched");
      }
      await this.deps.duties.deleteProgrammeShiftsInTx(tx, context, shifts);
      if (programme.eventId) await this.deps.events.deleteProgrammeEventInTx(tx, programme.eventId);
      await this.deps.activities.deleteProgrammeActivitiesInTx(
        tx,
        context,
        activities.map((a) => a.id),
      );
      await repo.deleteProgramme(tx, programmeId);
      await audit.record(tx, {
        action: "programme.deleted",
        resourceType: "programme",
        resourceId: programmeId,
      });
    });
  }

  // --- Internals ------------------------------------------------------------------

  private async untouched(
    tx: Tx,
    programme: repo.ProgrammeRow,
    activities: readonly { id: string }[],
    shifts: readonly ShiftRow[],
  ): Promise<boolean> {
    const ids = activities.map((a) => a.id);
    if (await this.deps.activities.anyRecordsInTx(tx, ids)) return false;
    if (
      (
        await this.deps.duties.assignmentsInTx(
          tx,
          shifts.map((s) => s.id),
        )
      ).length > 0
    )
      return false;
    if (programme.eventId && (await this.deps.events.anyRegistrationsInTx(tx, programme.eventId))) {
      return false;
    }
    return !(await this.deps.carpools.hasOffersInTx(tx, ids));
  }

  private async groupNames(
    tx: Tx,
    clubId: string,
    programmes: readonly repo.ProgrammeRow[],
  ): Promise<Map<string, string>> {
    return this.deps.activities.groupNamesInTx(tx, clubId, [
      ...new Set(programmes.flatMap((p) => p.groupIds)),
    ]);
  }

  private titleOf(
    snapshot: TemplateSnapshot,
    input: { title?: string | null | undefined },
  ): string {
    return input.title?.trim() || snapshot.name;
  }

  private editionOf(input: ApplyProgrammeInput, layout: Layout): string {
    return input.edition?.trim() || layout.firstDay.slice(0, 4);
  }

  /** The template, or a programme as a template made on the fly (copying). */
  private async snapshot(
    tx: Tx,
    context: TenantContext,
    from: { templateId: string } | { programmeId: string },
  ): Promise<TemplateSnapshot> {
    if ("templateId" in from) {
      const template = await repo.template(tx, from.templateId);
      if (!template) throw new DomainError("not_found");
      if (template.archived) throw new DomainError("programme_template_archived");
      return {
        templateId: template.id,
        name: template.name,
        eventSettings: template.eventSettings,
        dayCount: template.dayCount,
        slots: await repo.slots(tx, template.id),
        items: await repo.items(tx, template.id),
      };
    }
    const programme = await repo.programme(tx, from.programmeId);
    if (!programme) throw new DomainError("not_found");
    const loaded = await this.loadSource(tx, context, { programmeId: programme.id });
    const club = await this.deps.clubs.getClubInTx(tx, context.clubId);
    const content = templateFromSource(loaded, club.timeZone, new Map());
    // Copying keeps the groups: each slot is a group, by its ID.
    const keyOf = new Map(content.slots.map((s) => [s.key, s.defaultGroupId!]));
    return {
      templateId: programme.templateId,
      name: programme.title,
      eventSettings: loaded.eventSettings,
      dayCount: content.dayCount,
      slots: content.slots.map((s) => ({ ...s, key: s.defaultGroupId!, label: s.defaultGroupId! })),
      items: content.items.map((i) => ({ ...i, slotKeys: i.slotKeys.map((k) => keyOf.get(k)!) })),
    };
  }

  private async layout(
    tx: Tx,
    context: TenantContext,
    from: { templateId: string } | { programmeId: string },
    input: ApplyProgrammeInput | CopyProgrammeInput,
  ): Promise<{ layout: Layout; snapshot: TemplateSnapshot; timeZone: string }> {
    const data =
      "templateId" in from
        ? parseInput(ApplyProgrammeSchema, input)
        : parseInput(CopyProgrammeSchema, input);
    const snapshot = await this.snapshot(tx, context, from);
    const club = await this.deps.clubs.getClubInTx(tx, context.clubId);
    const asked = data.slots;
    const mentioned = [
      ...new Set([
        ...Object.values(asked).flat(),
        ...snapshot.slots.flatMap((s) => (s.defaultGroupId ? [s.defaultGroupId] : [])),
      ]),
    ];
    const groups = await this.deps.activities.clubGroupsInTx(tx, context.clubId, mentioned);
    const groupFacts = new Map(groups.map((g) => [g.id, { archived: g.archived }]));
    const mapping = slotMapping(
      snapshot.slots,
      asked,
      (id) => groupFacts.get(id)?.archived === false,
    );
    const placeIds = [
      ...new Set(
        snapshot.items.flatMap((i) =>
          i.locationId ? [data.locations[i.locationId] ?? i.locationId] : [],
        ),
      ),
    ];
    const places = await this.deps.activities.findLocationsInTx(tx, placeIds);
    const locationFacts = new Map(
      places
        .filter((l) => l.clubId === context.clubId)
        .map((l) => [l.id, { archived: l.archivedAt !== null }]),
    );
    const dutyRefusals = await this.deps.duties.typeRefusalsInTx(
      tx,
      context.clubId,
      snapshot.items.flatMap((i) => (i.dutyTypeId ? [i.dutyTypeId] : [])),
    );
    const lastDay = addDays(data.firstDay, Math.max(0, snapshot.dayCount - 1));
    const existing = await this.deps.activities.activitiesAtLocationsInTx(
      tx,
      context.clubId,
      [...locationFacts.keys()],
      {
        from: instantOf(data.firstDay, "00:00", club.timeZone),
        to: instantOf(addDays(lastDay, 1), "00:00", club.timeZone),
      },
    );
    const layout = layOut(
      snapshot,
      snapshot.eventSettings,
      { firstDay: data.firstDay, slots: mapping, locations: data.locations },
      {
        timeZone: club.timeZone,
        now: this.now(),
        groups: groupFacts,
        locations: locationFacts,
        dutyRefusals,
        existing,
      },
    );
    return { layout, snapshot, timeZone: club.timeZone };
  }

  /** A source's activities and shifts (and its event's settings), without people. */
  private async loadSource(
    tx: Tx,
    context: TenantContext,
    source: ProgrammeTemplateSource,
  ): Promise<{
    activities: SourceActivity[];
    shifts: SourceShift[];
    eventSettings: ProgrammeEventSettings | null;
  }> {
    const { activities, duties, events } = this.deps;
    let rows: Awaited<ReturnType<ActivitiesService["programmeActivitiesInTx"]>>;
    let shifts: ShiftRow[];
    let eventId: string | null = null;
    if ("programmeId" in source) {
      const programme = await repo.programme(tx, source.programmeId);
      if (!programme) throw new DomainError("not_found");
      rows = await activities.programmeActivitiesInTx(tx, programme.id);
      shifts = await duties.shiftsOfInTx(tx, { programmeId: programme.id, range: null });
      eventId = programme.eventId;
    } else if ("eventId" in source) {
      const found = await events.eventForTemplateInTx(tx, source.eventId);
      if (!found) throw new DomainError("not_found");
      rows = await activities.activitiesInTx(tx, found.activityIds);
      shifts = [
        ...(await duties.shiftsOfInTx(tx, { activityIds: found.activityIds })),
        ...(await duties.shiftsOfInTx(tx, { eventId: source.eventId })),
      ];
      eventId = source.eventId;
    } else if ("activityId" in source) {
      rows = await activities.activitiesInTx(tx, [source.activityId]);
      if (rows.length === 0) throw new DomainError("not_found");
      shifts = await duties.shiftsOfInTx(tx, { activityIds: [source.activityId] });
    } else if ("empty" in source) {
      throw new DomainError("programme_source_empty");
    } else {
      const days = daysBetween(source.from, source.to);
      if (days < 0 || days >= PROGRAMME_RANGE_DAYS_MAX) {
        throw new DomainError("programme_range_too_long");
      }
      const club = await this.deps.clubs.getClubInTx(tx, context.clubId);
      const range = {
        from: instantOf(source.from, "00:00", club.timeZone),
        to: instantOf(addDays(source.to, 1), "00:00", club.timeZone),
      };
      rows = await activities.groupActivitiesInRangeInTx(tx, source.groupId, range);
      shifts = [
        ...(await duties.shiftsOfInTx(tx, { activityIds: rows.map((r) => r.id) })),
        ...(await duties.groupShiftsInTx(tx, source.groupId, range)),
      ];
    }
    rows = rows.filter((r) => r.status === "scheduled");
    const groupsOf = await activities.groupsOfActivitiesInTx(
      tx,
      rows.map((r) => r.id),
    );
    const seen = new Set<string>();
    const kept = new Set(rows.map((r) => r.id));
    const uniqueShifts = shifts.filter(
      (s) => !seen.has(s.id) && seen.add(s.id) && (s.activityId === null || kept.has(s.activityId)),
    );
    let eventSettings: ProgrammeEventSettings | null = null;
    if (eventId) {
      const found = await events.eventForTemplateInTx(tx, eventId);
      if (found) {
        const e = found.event;
        const club = await this.deps.clubs.getClubInTx(tx, context.clubId);
        const first = rows.length > 0 ? localDate(rows[0]!.startsAt, club.timeZone) : null;
        const before = (at: Date | null) =>
          at && first ? Math.max(0, daysBetween(localDate(at, club.timeZone), first)) : null;
        eventSettings = ProgrammeEventSettingsSchema.parse({
          title: e.title,
          description: e.description,
          audience: e.audience,
          capacity: e.capacity,
          waitlistMode: e.waitlistMode,
          questions: e.questions,
          priceText: e.priceText,
          opensDaysBefore: before(e.registrationOpensAt),
          closesDaysBefore: before(e.registrationClosesAt),
        });
      }
    }
    return {
      activities: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        kindLabel: r.kindLabel,
        title: r.title,
        notes: r.notes,
        locationId: r.locationId,
        locationText: r.locationText,
        startsAt: r.startsAt,
        endsAt: r.endsAt,
        meetAt: r.meetAt,
        meetPlace: r.meetPlace,
        transportMode: r.transportMode,
        homeAway: r.homeAway,
        opponent: r.opponent,
        responseMode: r.responseMode,
        groupIds: (groupsOf.get(r.id) ?? []).map((g) => g.id),
      })),
      shifts: uniqueShifts.map((s) => ({
        id: s.id,
        groupId: s.groupId,
        dutyTypeId: s.dutyTypeId,
        title: s.title,
        note: s.note,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        locationId: s.locationId,
        needed: s.needed,
        activityId: s.activityId,
      })),
      eventSettings,
    };
  }

  /** The template's places and duty types are the club's (archived ones are refused when laid out). */
  private async requireItemReferences(
    tx: Tx,
    clubId: string,
    items: readonly repo.StoredItem[],
  ): Promise<void> {
    const locationIds = [...new Set(items.flatMap((i) => (i.locationId ? [i.locationId] : [])))];
    const places = await this.deps.activities.findLocationsInTx(tx, locationIds);
    if (places.filter((l) => l.clubId === clubId).length !== locationIds.length) {
      throw new DomainError("not_found");
    }
    const typeIds = [...new Set(items.flatMap((i) => (i.dutyTypeId ? [i.dutyTypeId] : [])))];
    if ((await this.deps.duties.typesByIdInTx(tx, typeIds)).length !== typeIds.length) {
      throw new DomainError("not_found");
    }
  }
}
