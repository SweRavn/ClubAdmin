// SPDX-License-Identifier: AGPL-3.0-only
// Activities (P1.4, ADR 0034): the club's locations, single activities,
// weekly series materialised as sessions, the group and club calendars and
// "My schedule". Every change rewrites the read model (schedule_entries) of
// the activities it touched in the same transaction, so calendars and
// schedules never lag; joining or leaving a group takes effect at once
// because schedules read the open group memberships.

import { getCountryPack } from "@clubadmin/country-packs";
import {
  type ActorContext,
  audit,
  type Database,
  isUniqueViolation,
  outbox,
  type TenantContext,
  type Tx,
} from "@clubadmin/db";
import {
  CALENDAR_MAX_DAYS,
  type CancelActivityInput,
  CancelActivitySchema,
  type CreateActivityInput,
  CreateActivitySchema,
  type CreateSeriesInput,
  CreateSeriesSchema,
  defaultResponseMode,
  type LocationInput,
  LocationInputSchema,
  type SeriesPreviewInput,
  SeriesPreviewSchema,
  type SeriesSlot,
  type SplitSeriesInput,
  SplitSeriesSchema,
  type UpdateActivityInput,
  UpdateActivitySchema,
  type UpdateLocationInput,
  UpdateLocationSchema,
  type UpdateSeriesInput,
  UpdateSeriesSchema,
  uuidv7,
} from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { actorPersonId, definedOnly, parseInput } from "../../platform/domain/run.ts";
import type { ClubsService } from "../clubs/index.ts";
import * as repo from "./activities.repository.ts";
import * as records from "./attendance.repository.ts";
import { expandSeries, type Expansion, localDate, RecurrenceError } from "./recurrence.ts";

export type Location = repo.LocationRow;
export type ScheduleRow = repo.ScheduleRow;

export interface ActivityView {
  activity: repo.ActivityRow;
  groups: { id: string; name: string }[];
  location: Location | null;
  timeZone: string;
}

export interface SeriesView {
  series: repo.SeriesRow;
  groups: { id: string; name: string }[];
  location: Location | null;
  timeZone: string;
  sessions: number;
}

export interface SeriesChange {
  series: SeriesView;
  created: number;
  updated: number;
  removed: number;
}

const DAY_MS = 86_400_000;

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

function recurrenceError(error: unknown): never {
  if (error instanceof RecurrenceError) throw new DomainError(error.code);
  throw error;
}

function locationWriteError(error: unknown): never {
  if (isUniqueViolation(error, "locations_name_unique")) {
    throw new DomainError("location_name_taken");
  }
  throw error;
}

/** Fields of a session that a calendar shows: changing one bumps sequence and changed_at. */
const SHOWN_FIELDS = [
  "kind",
  "kindLabel",
  "title",
  "notes",
  "startsAt",
  "endsAt",
  "allDay",
  "meetAt",
  "meetPlace",
  "locationId",
  "locationText",
  "opponent",
  "homeAway",
  "competition",
] as const;

const sameValue = (a: unknown, b: unknown) =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;

export class ActivitiesService {
  private readonly db: Database;
  private readonly clubs: ClubsService;
  private readonly now: () => Date;

  constructor(db: Database, clubs: ClubsService, now: () => Date = () => new Date()) {
    this.db = db;
    this.clubs = clubs;
    this.now = now;
  }

  // --- Locations -----------------------------------------------------------------

  listLocations(
    context: TenantContext,
    page: { cursor?: string | undefined; limit: number; archived: boolean },
  ): Promise<{ items: Location[]; nextCursor: string | null }> {
    return this.db.withTenant(context, async (tx) => {
      const rows = await repo.listLocations(tx, context.clubId, {
        cursor: page.cursor ?? null,
        limit: page.limit + 1,
        archived: page.archived,
      });
      const items = rows.slice(0, page.limit);
      return { items, nextCursor: rows.length > page.limit ? items.at(-1)!.id : null };
    });
  }

  /** `id`: a fixed ID (the demo seed). */
  createLocation(
    context: TenantContext,
    input: LocationInput,
    options: { id?: string } = {},
  ): Promise<Location> {
    return this.db.withTenant(context, async (tx) => {
      const data = parseInput(LocationInputSchema, input);
      const location = await repo
        .insertLocation(tx, {
          id: options.id ?? uuidv7(),
          clubId: context.clubId,
          name: data.name,
          street: data.street ?? null,
          postalCode: data.postalCode ?? null,
          city: data.city ?? null,
          latitude: data.latitude ?? null,
          longitude: data.longitude ?? null,
          directions: data.directions ?? null,
          createdByPersonId: context.personId ?? null,
        })
        .catch(locationWriteError);
      await audit.record(tx, {
        action: "location.created",
        resourceType: "location",
        resourceId: location.id,
        changedFields: Object.keys(definedOnly(data)),
      });
      return location;
    });
  }

  /**
   * Archiving keeps the activities there; a new name shows in calendars at
   * once. Without `anyLocation` (club managers) only the person who added the
   * location may change it (P1.6b).
   */
  updateLocation(
    context: TenantContext,
    locationId: string,
    input: UpdateLocationInput,
    options: { anyLocation?: boolean } = { anyLocation: true },
  ): Promise<Location> {
    return this.db.withTenant(context, async (tx) => {
      const data = definedOnly(parseInput(UpdateLocationSchema, input));
      const [current] = await repo.findLocations(tx, [locationId]);
      if (current?.clubId !== context.clubId) throw new DomainError("not_found");
      if (
        !options.anyLocation &&
        (current.createdByPersonId === null || current.createdByPersonId !== context.personId)
      ) {
        throw new DomainError("not_allowed");
      }
      const { archived, ...fields } = data;
      const values = {
        ...fields,
        ...(archived === undefined
          ? {}
          : { archivedAt: archived ? (current.archivedAt ?? this.now()) : null }),
      };
      const location = (await repo
        .updateLocation(tx, locationId, values)
        .catch(locationWriteError))!;
      if (location.name !== current.name) {
        await repo.syncScheduleEntries(tx, { locationId });
      }
      await audit.record(tx, {
        action: "location.updated",
        resourceType: "location",
        resourceId: locationId,
        changedFields: Object.keys(data),
      });
      return location;
    });
  }

  // --- Single activities -------------------------------------------------------------

  /**
   * An activity of the group, and of `groupIds` for a joint one (the caller
   * has checked that the actor manages each of them).
   */
  createActivity(
    context: TenantContext,
    groupId: string,
    input: CreateActivityInput,
    options: { id?: string } = {},
  ): Promise<ActivityView> {
    return this.db.withTenant(context, (tx) =>
      this.createActivityInTx(tx, context, groupId, input, options),
    );
  }

  /** As createActivity, in the caller's transaction (events, P1.6). */
  async createActivityInTx(
    tx: Tx,
    context: TenantContext,
    groupId: string,
    input: CreateActivityInput,
    options: { id?: string } = {},
  ): Promise<ActivityView> {
    const data = parseInput(CreateActivitySchema, input);
    const groupIds = [...new Set([groupId, ...data.groupIds])];
    await this.requireGroups(tx, context.clubId, groupIds);
    const locationId = data.locationId ?? null;
    if (locationId) await this.requireLocation(tx, context.clubId, locationId);
    const [activity] = await repo.insertActivities(tx, [
      {
        id: options.id ?? uuidv7(),
        clubId: context.clubId,
        kind: data.kind,
        kindLabel: data.kind === "other" ? (data.kindLabel ?? null) : null,
        title: data.title,
        notes: data.notes ?? null,
        leaderNotes: data.leaderNotes ?? null,
        meetPlace: data.meetPlace ?? null,
        opponent: data.opponent ?? null,
        homeAway: data.homeAway ?? null,
        competition: data.competition ?? null,
        locationId,
        locationText: locationId ? null : (data.locationText ?? null),
        startsAt: new Date(data.startsAt),
        endsAt: new Date(data.endsAt),
        allDay: data.allDay,
        meetAt: data.meetAt ? new Date(data.meetAt) : null,
        responseMode: data.responseMode ?? defaultResponseMode(data.kind),
        respondBy: data.respondBy ? new Date(data.respondBy) : null,
        createdByPersonId: actorPersonId(context),
      },
    ]);
    await repo.insertActivityGroups(tx, context.clubId, [activity!.id], groupIds);
    await repo.syncScheduleEntries(tx, { activityIds: [activity!.id] });
    await audit.record(tx, {
      action: "activity.created",
      resourceType: "activity",
      resourceId: activity!.id,
    });
    await this.publish(tx, context.clubId, activity!.id, "created");
    return (await this.views(tx, context.clubId, [activity!]))[0]!;
  }

  getActivity(context: TenantContext, activityId: string): Promise<ActivityView> {
    return this.db.withTenant(context, async (tx) => {
      const activity = await repo.findActivity(tx, activityId);
      if (!activity) throw new DomainError("not_found");
      return (await this.views(tx, context.clubId, [activity]))[0]!;
    });
  }

  /** A session of a series edited on its own becomes detached: series changes leave it alone. */
  updateActivity(
    context: TenantContext,
    activityId: string,
    input: UpdateActivityInput,
  ): Promise<ActivityView> {
    return this.db.withTenant(context, async (tx) => {
      const data = definedOnly(parseInput(UpdateActivitySchema, input));
      const current = await repo.lockActivity(tx, activityId);
      if (!current) throw new DomainError("not_found");
      const next: Partial<repo.NewActivityRow> = {
        ...(data.kind === undefined ? {} : { kind: data.kind }),
        // The label belongs to `other` activities only (P1.6b).
        ...((data.kind ?? current.kind) !== "other"
          ? current.kindLabel === null
            ? {}
            : { kindLabel: null }
          : "kindLabel" in data
            ? { kindLabel: data.kindLabel ?? null }
            : {}),
        ...(data.title === undefined ? {} : { title: data.title }),
        ...("notes" in data ? { notes: data.notes ?? null } : {}),
        ...("leaderNotes" in data ? { leaderNotes: data.leaderNotes ?? null } : {}),
        ...("meetPlace" in data ? { meetPlace: data.meetPlace ?? null } : {}),
        ...("opponent" in data ? { opponent: data.opponent ?? null } : {}),
        ...("homeAway" in data ? { homeAway: data.homeAway ?? null } : {}),
        ...("competition" in data ? { competition: data.competition ?? null } : {}),
        ...(data.startsAt === undefined ? {} : { startsAt: new Date(data.startsAt) }),
        ...(data.endsAt === undefined ? {} : { endsAt: new Date(data.endsAt) }),
        ...("meetAt" in data ? { meetAt: data.meetAt ? new Date(data.meetAt) : null } : {}),
        ...(data.responseMode === undefined ? {} : { responseMode: data.responseMode }),
        ...("respondBy" in data
          ? { respondBy: data.respondBy ? new Date(data.respondBy) : null }
          : {}),
      };
      if ("locationId" in data || "locationText" in data) {
        const locationId = data.locationId ?? null;
        if (locationId && locationId !== current.locationId) {
          await this.requireLocation(tx, context.clubId, locationId);
        }
        next.locationId = locationId;
        next.locationText = locationId ? null : (data.locationText ?? null);
      }
      const startsAt = next.startsAt ?? current.startsAt;
      const endsAt = next.endsAt ?? current.endsAt;
      if (endsAt.getTime() <= startsAt.getTime()) throw new DomainError("invalid_input");

      const changed = Object.keys(next).filter(
        (key) => !sameValue(next[key as keyof typeof next], current[key as keyof repo.ActivityRow]),
      );
      if (changed.length === 0) return (await this.views(tx, context.clubId, [current]))[0]!;
      const shown = changed.some((key) => (SHOWN_FIELDS as readonly string[]).includes(key));
      const activity = await repo.updateActivity(tx, activityId, {
        ...next,
        detached: current.seriesId !== null || current.detached,
        ...(shown ? { sequence: current.sequence + 1, changedAt: this.now() } : {}),
      });
      await repo.syncScheduleEntries(tx, { activityIds: [activityId] });
      await audit.record(tx, {
        action: "activity.updated",
        resourceType: "activity",
        resourceId: activityId,
        changedFields: changed,
      });
      await this.publish(tx, context.clubId, activityId, "updated");
      return (await this.views(tx, context.clubId, [activity]))[0]!;
    });
  }

  cancelActivity(
    context: TenantContext,
    activityId: string,
    input: CancelActivityInput,
  ): Promise<ActivityView> {
    return this.db.withTenant(context, async (tx) => {
      const data = parseInput(CancelActivitySchema, input);
      const current = await repo.lockActivity(tx, activityId);
      if (!current) throw new DomainError("not_found");
      if (current.status === "cancelled") throw new DomainError("activity_cancelled");
      const activity = await this.cancelLocked(tx, context, current, data.reason ?? null);
      return (await this.views(tx, context.clubId, [activity]))[0]!;
    });
  }

  /** Cancels these activities if still scheduled (a cancelled event, P1.6). */
  async cancelActivitiesInTx(
    tx: Tx,
    context: TenantContext,
    activityIds: readonly string[],
    reason: string | null,
  ): Promise<void> {
    for (const id of activityIds) {
      const current = await repo.lockActivity(tx, id);
      if (current?.status === "scheduled") await this.cancelLocked(tx, context, current, reason);
    }
  }

  /** These activities' rows (events, P1.6; the club's only, by row-level security). */
  activitiesInTx(tx: Tx, ids: readonly string[]): Promise<repo.ActivityRow[]> {
    return repo.findActivities(tx, ids);
  }

  /** The club's locations among these IDs (archived ones included). */
  locationsInTx(tx: Tx, ids: readonly string[]): Promise<Location[]> {
    return ids.length === 0 ? Promise.resolve([]) : repo.findLocations(tx, ids);
  }

  /** Groups of the club that are not archived (else not_found / group_archived). */
  requireGroupsInTx(tx: Tx, clubId: string, groupIds: readonly string[]): Promise<void> {
    return this.requireGroups(tx, clubId, groupIds);
  }

  /** The club's groups among these IDs, by ID, with their names. */
  async groupNamesInTx(
    tx: Tx,
    clubId: string,
    groupIds: readonly string[],
  ): Promise<Map<string, string>> {
    if (groupIds.length === 0) return new Map();
    return new Map((await repo.clubGroups(tx, clubId, groupIds)).map((g) => [g.id, g.name]));
  }

  private async cancelLocked(
    tx: Tx,
    context: TenantContext,
    current: repo.ActivityRow,
    reason: string | null,
  ): Promise<repo.ActivityRow> {
    const activityId = current.id;
    const activity = await repo.updateActivity(tx, activityId, {
      status: "cancelled",
      cancelledReason: reason,
      sequence: current.sequence + 1,
      changedAt: this.now(),
    });
    await repo.syncScheduleEntries(tx, { activityIds: [activityId] });
    await audit.record(tx, {
      action: "activity.cancelled",
      resourceType: "activity",
      resourceId: activityId,
    });
    await this.publish(tx, context.clubId, activityId, "cancelled");
    return activity;
  }

  restoreActivity(context: TenantContext, activityId: string): Promise<ActivityView> {
    return this.db.withTenant(context, async (tx) => {
      const current = await repo.lockActivity(tx, activityId);
      if (!current) throw new DomainError("not_found");
      if (current.status !== "cancelled") throw new DomainError("activity_not_cancelled");
      const activity = await repo.updateActivity(tx, activityId, {
        status: "scheduled",
        cancelledReason: null,
        sequence: current.sequence + 1,
        changedAt: this.now(),
      });
      await repo.syncScheduleEntries(tx, { activityIds: [activityId] });
      await audit.record(tx, {
        action: "activity.restored",
        resourceType: "activity",
        resourceId: activityId,
      });
      await this.publish(tx, context.clubId, activityId, "restored");
      return (await this.views(tx, context.clubId, [activity]))[0]!;
    });
  }

  /**
   * Deleting a session of a series skips its date, so series changes do not
   * bring it back. An activity with answers or attendance is cancelled
   * instead (activity_has_responses).
   */
  deleteActivity(context: TenantContext, activityId: string): Promise<void> {
    return this.db.withTenant(context, async (tx) => {
      const current = await repo.lockActivity(tx, activityId);
      if (!current) throw new DomainError("not_found");
      if ((await records.withRecords(tx, [activityId])).size > 0) {
        throw new DomainError("activity_has_responses");
      }
      if (current.seriesId && current.occurrenceOn) {
        const series = await repo.lockSeries(tx, current.seriesId);
        if (series && !series.skipDates.includes(current.occurrenceOn)) {
          await repo.updateSeries(tx, series.id, {
            skipDates: [...series.skipDates, current.occurrenceOn].sort(),
          });
        }
      }
      await repo.deleteActivities(tx, [activityId]);
      await audit.record(tx, {
        action: "activity.deleted",
        resourceType: "activity",
        resourceId: activityId,
      });
      await this.publish(tx, context.clubId, activityId, "deleted");
    });
  }

  // --- Series ---------------------------------------------------------------------

  /** The sessions a series would have (for the form's preview; nothing is stored). */
  previewSeries(
    context: TenantContext,
    input: SeriesPreviewInput,
  ): Promise<Expansion & { timeZone: string }> {
    return this.db.withTenant(context, async (tx) => {
      const data = parseInput(SeriesPreviewSchema, input);
      const club = await this.clubs.getClubInTx(tx, context.clubId);
      return { timeZone: club.timeZone, ...this.expand(club, data) };
    });
  }

  createSeries(
    context: TenantContext,
    groupId: string,
    input: CreateSeriesInput,
    options: { id?: string; sessionId?: (date: string) => string } = {},
  ): Promise<SeriesChange> {
    return this.db.withTenant(context, async (tx) => {
      const data = parseInput(CreateSeriesSchema, input);
      const groupIds = [...new Set([groupId, ...data.groupIds])];
      await this.requireGroups(tx, context.clubId, groupIds);
      const locationId = data.locationId ?? null;
      if (locationId) await this.requireLocation(tx, context.clubId, locationId);
      const club = await this.clubs.getClubInTx(tx, context.clubId);
      const { sessions } = this.expand(club, data);
      const series = await repo.insertSeries(
        tx,
        {
          id: options.id ?? uuidv7(),
          clubId: context.clubId,
          kind: data.kind,
          title: data.title,
          notes: data.notes ?? null,
          leaderNotes: data.leaderNotes ?? null,
          locationId,
          locationText: locationId ? null : (data.locationText ?? null),
          slots: data.slots,
          startsOn: data.startsOn,
          endsOn: data.endsOn,
          skipDates: [...new Set(data.skipDates)].sort(),
          skipPublicHolidays: data.skipPublicHolidays,
          responseMode: data.responseMode ?? defaultResponseMode(data.kind),
          respondByMinutes: data.respondByMinutes ?? null,
          createdByPersonId: actorPersonId(context),
        },
        groupIds,
      );
      const created = await this.insertSessions(tx, series, groupIds, sessions, options.sessionId);
      await audit.record(tx, {
        action: "activity.series.created",
        resourceType: "activity_series",
        resourceId: series.id,
      });
      await outbox.publish(tx, "activity_series.changed", {
        clubId: context.clubId,
        seriesId: series.id,
        change: "created",
      });
      return {
        series: await this.seriesView(tx, series),
        created: created.length,
        updated: 0,
        removed: 0,
      };
    });
  }

  getSeries(context: TenantContext, seriesId: string): Promise<SeriesView> {
    return this.db.withTenant(context, async (tx) => {
      const series = await repo.findSeries(tx, seriesId);
      if (!series) throw new DomainError("not_found");
      return this.seriesView(tx, series);
    });
  }

  /**
   * Changes a series from a date (default: today in the club's time zone;
   * never in the past). Its sessions from then on follow the new rules:
   * matching dates are updated, dates no longer in the pattern removed, new
   * ones added. Detached sessions are left alone.
   */
  updateSeries(
    context: TenantContext,
    seriesId: string,
    input: UpdateSeriesInput,
  ): Promise<SeriesChange> {
    return this.db.withTenant(context, async (tx) => {
      const data = parseInput(UpdateSeriesSchema, input);
      const current = await repo.lockSeries(tx, seriesId);
      if (!current) throw new DomainError("not_found");
      const club = await this.clubs.getClubInTx(tx, context.clubId);
      const today = localDate(this.now(), club.timeZone);
      const from = data.from ?? today;
      if (from < today) throw new DomainError("series_change_in_past");
      const values = await this.seriesValues(tx, context.clubId, current, data);
      if (values.endsOn !== undefined && values.endsOn < current.startsOn) {
        throw new DomainError("invalid_recurrence");
      }
      const series = await repo.updateSeries(tx, seriesId, values);
      const groupIds = await repo.seriesGroupIds(tx, seriesId);
      const counts = await this.applyRules(tx, club, series, groupIds, from);
      await audit.record(tx, {
        action: "activity.series.updated",
        resourceType: "activity_series",
        resourceId: seriesId,
        changedFields: Object.keys(definedOnly(data)).filter((k) => k !== "from"),
      });
      await outbox.publish(tx, "activity_series.changed", {
        clubId: context.clubId,
        seriesId,
        change: "updated",
      });
      return { series: await this.seriesView(tx, series), ...counts };
    });
  }

  /**
   * "This and following": the series ends the day before the session; a new
   * series with the changes takes over the session and the ones after it
   * (detached sessions keep their changes). Returns the new series.
   */
  splitSeries(
    context: TenantContext,
    seriesId: string,
    input: SplitSeriesInput,
    options: { id?: string } = {},
  ): Promise<SeriesChange> {
    return this.db.withTenant(context, async (tx) => {
      const data = parseInput(SplitSeriesSchema, input);
      const current = await repo.lockSeries(tx, seriesId);
      if (!current) throw new DomainError("not_found");
      const session = await repo.findActivity(tx, data.activityId);
      if (session?.seriesId !== seriesId || !session.occurrenceOn) {
        throw new DomainError("not_a_series_session");
      }
      const club = await this.clubs.getClubInTx(tx, context.clubId);
      const day = session.occurrenceOn;
      if (day < localDate(this.now(), club.timeZone)) {
        throw new DomainError("series_change_in_past");
      }
      const { activityId: _activityId, ...changes } = data;
      const values = await this.seriesValues(tx, context.clubId, current, changes);
      const groupIds = await repo.seriesGroupIds(tx, seriesId);

      // At the first session there is nothing before it to keep: change the whole series.
      if (day === current.startsOn) {
        const series = await repo.updateSeries(tx, seriesId, values);
        const counts = await this.applyRules(tx, club, series, groupIds, day);
        await this.recordSplit(tx, context.clubId, seriesId, seriesId);
        return { series: await this.seriesView(tx, series), ...counts };
      }

      const later = await repo.seriesSessions(tx, seriesId, day);
      await repo.updateSeries(tx, seriesId, { endsOn: addDays(day, -1) });
      const successor = await repo.insertSeries(
        tx,
        {
          ...current,
          ...values,
          id: options.id ?? uuidv7(),
          startsOn: day,
          skipDates: (values.skipDates ?? current.skipDates).filter((d) => d >= day),
          createdByPersonId: actorPersonId(context),
          createdAt: undefined,
          updatedAt: undefined,
        },
        groupIds,
      );
      await repo.moveSessionsToSeries(
        tx,
        later.map((s) => s.id),
        successor.id,
      );
      const counts = await this.applyRules(tx, club, successor, groupIds, day);
      await this.recordSplit(tx, context.clubId, seriesId, successor.id);
      return { series: await this.seriesView(tx, successor), ...counts };
    });
  }

  // --- Calendars ----------------------------------------------------------------------

  groupCalendar(
    context: TenantContext,
    groupId: string,
    query: { from: string; to: string; cursor?: string | undefined; limit: number },
  ): Promise<{ items: ActivityView[]; nextCursor: string | null }> {
    return this.db.withTenant(context, async (tx) => {
      const range = checkedRange(query);
      const rows = await repo.groupCalendar(tx, groupId, {
        ...range,
        cursor: query.cursor ?? null,
        limit: query.limit + 1,
      });
      return this.page(tx, context.clubId, rows, query.limit);
    });
  }

  clubCalendar(
    context: TenantContext,
    query: {
      from: string;
      to: string;
      groupId?: string | undefined;
      locationId?: string | undefined;
      cursor?: string | undefined;
      limit: number;
    },
  ): Promise<{ items: ActivityView[]; nextCursor: string | null }> {
    return this.db.withTenant(context, async (tx) => {
      const range = checkedRange(query);
      const rows = await repo.clubCalendar(tx, context.clubId, {
        ...range,
        groupId: query.groupId ?? null,
        locationId: query.locationId ?? null,
        cursor: query.cursor ?? null,
        limit: query.limit + 1,
      });
      return this.page(tx, context.clubId, rows, query.limit);
    });
  }

  /** Scheduled activities at the same location whose times overlap (at most 200 pairs). */
  locationConflicts(
    context: TenantContext,
    locationId: string,
    query: { from: string; to: string },
  ): Promise<[ActivityView, ActivityView][]> {
    return this.db.withTenant(context, async (tx) => {
      const [location] = await repo.findLocations(tx, [locationId]);
      if (location?.clubId !== context.clubId) throw new DomainError("not_found");
      const pairs = await repo.locationConflicts(
        tx,
        context.clubId,
        locationId,
        checkedRange(query),
      );
      const ids = [...new Set(pairs.flat())];
      const rows = await repo.findActivities(tx, ids);
      const views = new Map(
        (await this.views(tx, context.clubId, rows)).map((v) => [v.activity.id, v]),
      );
      return pairs.flatMap(([a, b]) => {
        const first = views.get(a);
        const second = views.get(b);
        return first && second ? [[first, second] as [ActivityView, ActivityView]] : [];
      });
    });
  }

  // --- My schedule --------------------------------------------------------------------

  /**
   * The activities of these people's groups, across clubs (the caller decides
   * whose schedule the actor may see; row-level security limits it to the
   * actor and their wards). Group and club names come along.
   */
  schedule(
    context: ActorContext,
    input: {
      personIds: readonly string[];
      from: string;
      to: string;
      clubId?: string | undefined;
      cursor?: string | undefined;
      limit: number;
    },
  ): Promise<{
    items: ScheduleRow[];
    nextCursor: string | null;
    groups: Map<string, string>;
    clubs: Map<string, { name: string; timeZone: string }>;
  }> {
    return this.db.withActor(context, async (tx) => {
      const range = checkedRange(input);
      const rows = await repo.schedule(tx, {
        personIds: input.personIds,
        ...range,
        clubId: input.clubId ?? null,
        cursor: input.cursor ?? null,
        limit: input.limit + 1,
      });
      const items = rows.slice(0, input.limit);
      const groups = await repo.groupNames(tx, [...new Set(items.flatMap((r) => r.groupIds))]);
      const clubs = await this.clubs.findClubsInTx(tx, [...new Set(items.map((r) => r.clubId))]);
      return {
        items,
        nextCursor: rows.length > input.limit ? items.at(-1)!.activityId : null,
        groups,
        clubs: new Map(clubs.map((c) => [c.id, { name: c.name, timeZone: c.timeZone }])),
      };
    });
  }

  // --- Internals ----------------------------------------------------------------------

  private expand(
    club: { country: string; timeZone: string },
    rules: {
      slots: readonly SeriesSlot[];
      startsOn: string;
      endsOn: string;
      skipDates: readonly string[];
      skipPublicHolidays: boolean;
    },
  ): Expansion {
    const holidays = new Set<string>();
    if (rules.skipPublicHolidays) {
      const pack = getCountryPack(club.country);
      const first = Number(rules.startsOn.slice(0, 4));
      const last = Number(rules.endsOn.slice(0, 4));
      for (let year = first; year <= last; year++) {
        for (const day of pack.publicHolidays(year)) holidays.add(day);
      }
    }
    try {
      return expandSeries({ ...rules, holidays, timeZone: club.timeZone });
    } catch (error) {
      return recurrenceError(error);
    }
  }

  /** The new column values of a series from an update (validated). */
  private async seriesValues(
    tx: Tx,
    clubId: string,
    current: repo.SeriesRow,
    data: Omit<UpdateSeriesInput, "from">,
  ): Promise<Partial<repo.SeriesRow>> {
    const values: Partial<repo.SeriesRow> = {
      ...(data.kind === undefined ? {} : { kind: data.kind }),
      ...(data.title === undefined ? {} : { title: data.title }),
      ...(data.notes === undefined ? {} : { notes: data.notes ?? null }),
      ...(data.leaderNotes === undefined ? {} : { leaderNotes: data.leaderNotes ?? null }),
      ...(data.slots === undefined ? {} : { slots: data.slots }),
      ...(data.endsOn === undefined ? {} : { endsOn: data.endsOn }),
      ...(data.skipDates === undefined ? {} : { skipDates: [...new Set(data.skipDates)].sort() }),
      ...(data.skipPublicHolidays === undefined
        ? {}
        : { skipPublicHolidays: data.skipPublicHolidays }),
      ...(data.responseMode === undefined ? {} : { responseMode: data.responseMode }),
      ...(data.respondByMinutes === undefined
        ? {}
        : { respondByMinutes: data.respondByMinutes ?? null }),
    };
    if (data.locationId !== undefined || data.locationText !== undefined) {
      const locationId = data.locationId ?? null;
      if (locationId && locationId !== current.locationId) {
        await this.requireLocation(tx, clubId, locationId);
      }
      values.locationId = locationId;
      values.locationText = locationId ? null : (data.locationText ?? null);
    }
    return values;
  }

  /**
   * Makes the series' sessions on or after `from` follow its rules (the
   * diff described on updateSeries), and rewrites their calendar entries.
   */
  private async applyRules(
    tx: Tx,
    club: { country: string; timeZone: string },
    series: repo.SeriesRow,
    groupIds: readonly string[],
    from: string,
  ): Promise<{ created: number; updated: number; removed: number }> {
    const { sessions } = this.expand(club, series);
    const wanted = sessions.filter((s) => s.date >= from);
    const existing = await repo.seriesSessions(tx, series.id, from);
    const detachedDates = new Set(existing.filter((a) => a.detached).map((a) => a.occurrenceOn));
    const byDate = new Map(existing.filter((a) => !a.detached).map((a) => [a.occurrenceOn!, a]));
    const updates: Parameters<typeof repo.updateSessions>[1][number][] = [];
    const inserts: typeof wanted = [];
    for (const session of wanted) {
      if (detachedDates.has(session.date)) continue;
      const row = byDate.get(session.date);
      byDate.delete(session.date);
      if (!row) {
        inserts.push(session);
        continue;
      }
      const next = {
        id: row.id,
        startsAt: session.startsAt,
        endsAt: session.endsAt,
        kind: series.kind,
        title: series.title,
        notes: series.notes,
        leaderNotes: series.leaderNotes,
        locationId: series.locationId,
        locationText: series.locationText,
        responseMode: series.responseMode,
        respondBy: respondByOf(series, session.startsAt),
      };
      const shown =
        row.startsAt.getTime() !== next.startsAt.getTime() ||
        row.endsAt.getTime() !== next.endsAt.getTime() ||
        row.kind !== next.kind ||
        row.title !== next.title ||
        row.notes !== next.notes ||
        row.locationId !== next.locationId ||
        row.locationText !== next.locationText;
      const answers =
        row.responseMode !== next.responseMode ||
        row.respondBy?.getTime() !== next.respondBy?.getTime();
      if (shown || answers || row.leaderNotes !== next.leaderNotes) {
        updates.push({ ...next, bump: shown });
      }
    }
    // Sessions no longer in the pattern: deleted, unless someone answered (or
    // attendance was taken); those are cancelled so the answers stay (ADR 0035).
    const dropped = [...byDate.values()];
    const kept = await records.withRecords(
      tx,
      dropped.map((a) => a.id),
    );
    const removed = dropped.filter((a) => !kept.has(a.id)).map((a) => a.id);
    const cancelled = dropped.filter((a) => kept.has(a.id) && a.status !== "cancelled");
    await repo.deleteActivities(tx, removed);
    await repo.updateSessions(tx, updates);
    for (const a of cancelled) {
      await repo.updateActivity(tx, a.id, {
        status: "cancelled",
        sequence: a.sequence + 1,
        changedAt: this.now(),
      });
    }
    const created = await this.insertSessions(tx, series, groupIds, inserts);
    await repo.syncScheduleEntries(tx, {
      activityIds: [...updates.map((u) => u.id), ...cancelled.map((a) => a.id), ...created],
    });
    for (const a of cancelled) await this.publish(tx, series.clubId, a.id, "cancelled");
    return {
      created: created.length,
      updated: updates.length,
      removed: removed.length + cancelled.length,
    };
  }

  /** Inserts sessions of a series with its groups and calendar entries; returns their IDs. */
  private async insertSessions(
    tx: Tx,
    series: repo.SeriesRow,
    groupIds: readonly string[],
    sessions: readonly { date: string; startsAt: Date; endsAt: Date }[],
    sessionId?: (date: string) => string,
  ): Promise<string[]> {
    const rows = await repo.insertActivities(
      tx,
      sessions.map((s) => ({
        id: sessionId?.(s.date) ?? uuidv7(),
        clubId: series.clubId,
        seriesId: series.id,
        occurrenceOn: s.date,
        kind: series.kind,
        title: series.title,
        notes: series.notes,
        leaderNotes: series.leaderNotes,
        locationId: series.locationId,
        locationText: series.locationText,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        responseMode: series.responseMode,
        respondBy: respondByOf(series, s.startsAt),
        createdByPersonId: series.createdByPersonId,
      })),
    );
    const ids = rows.map((r) => r.id);
    await repo.insertActivityGroups(tx, series.clubId, ids, groupIds);
    await repo.syncScheduleEntries(tx, { activityIds: ids });
    return ids;
  }

  private async recordSplit(
    tx: Tx,
    clubId: string,
    seriesId: string,
    successorId: string,
  ): Promise<void> {
    await audit.record(tx, {
      action: "activity.series.split",
      resourceType: "activity_series",
      resourceId: seriesId,
    });
    await outbox.publish(tx, "activity_series.changed", { clubId, seriesId, change: "split" });
    if (successorId !== seriesId) {
      await outbox.publish(tx, "activity_series.changed", {
        clubId,
        seriesId: successorId,
        change: "created",
      });
    }
  }

  private async publish(
    tx: Tx,
    clubId: string,
    activityId: string,
    change: "created" | "updated" | "cancelled" | "restored" | "deleted",
  ): Promise<void> {
    await outbox.publish(tx, "activity.changed", { clubId, activityId, change });
  }

  /** Groups of the club that are not archived (else not_found / group_archived). */
  private async requireGroups(tx: Tx, clubId: string, groupIds: readonly string[]): Promise<void> {
    const found = await repo.clubGroups(tx, clubId, groupIds);
    if (found.length !== groupIds.length) throw new DomainError("not_found");
    if (found.some((g) => g.archived)) throw new DomainError("group_archived");
  }

  private async requireLocation(tx: Tx, clubId: string, locationId: string): Promise<void> {
    const [location] = await repo.findLocations(tx, [locationId]);
    if (location?.clubId !== clubId) throw new DomainError("not_found");
    if (location.archivedAt) throw new DomainError("location_archived");
  }

  private async page(
    tx: Tx,
    clubId: string,
    rows: repo.ActivityRow[],
    limit: number,
  ): Promise<{ items: ActivityView[]; nextCursor: string | null }> {
    const items = await this.views(tx, clubId, rows.slice(0, limit));
    return { items, nextCursor: rows.length > limit ? items.at(-1)!.activity.id : null };
  }

  private async views(
    tx: Tx,
    clubId: string,
    rows: readonly repo.ActivityRow[],
  ): Promise<ActivityView[]> {
    if (rows.length === 0) return [];
    const club = await this.clubs.getClubInTx(tx, clubId);
    const groups = await repo.groupsOfActivities(
      tx,
      rows.map((r) => r.id),
    );
    const locations = new Map(
      (
        await repo.findLocations(tx, [
          ...new Set(rows.flatMap((r) => (r.locationId ? [r.locationId] : []))),
        ])
      ).map((l) => [l.id, l]),
    );
    return rows.map((activity) => ({
      activity,
      groups: groups.get(activity.id) ?? [],
      location: activity.locationId ? (locations.get(activity.locationId) ?? null) : null,
      timeZone: club.timeZone,
    }));
  }

  private async seriesView(tx: Tx, series: repo.SeriesRow): Promise<SeriesView> {
    const club = await this.clubs.getClubInTx(tx, series.clubId);
    const groupIds = await repo.seriesGroupIds(tx, series.id);
    const groups = await repo.clubGroups(tx, series.clubId, groupIds);
    const [location] = series.locationId ? await repo.findLocations(tx, [series.locationId]) : [];
    return {
      series,
      groups: groups
        .map((g) => ({ id: g.id, name: g.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      location: location ?? null,
      timeZone: club.timeZone,
      sessions: await repo.countSeriesSessions(tx, series.id),
    };
  }
}

/** A session's deadline from its series' minutes before the start. */
function respondByOf(series: { respondByMinutes: number | null }, startsAt: Date): Date | null {
  return series.respondByMinutes === null
    ? null
    : new Date(startsAt.getTime() - series.respondByMinutes * 60_000);
}

/** A query range as dates: `to` after `from`, at most CALENDAR_MAX_DAYS. */
function checkedRange(query: { from: string; to: string }): { from: Date; to: Date } {
  const from = new Date(query.from);
  const to = new Date(query.to);
  if (to.getTime() <= from.getTime()) throw new DomainError("invalid_input");
  if (to.getTime() - from.getTime() > CALENDAR_MAX_DAYS * DAY_MS) {
    throw new DomainError("range_too_long");
  }
  return { from, to };
}
