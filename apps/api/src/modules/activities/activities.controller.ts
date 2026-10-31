// SPDX-License-Identifier: AGPL-3.0-only
// Locations, activities, series and the calendars (P1.4, ADR 0034). Whether
// the viewer manages an activity (canManage, leader notes) is decided here
// from the actor and all of the activity's groups.

import {
  type Activity,
  type ActivityDetail,
  ActivityDetailSchema,
  type ActivityPage,
  ActivityPageSchema,
  ActivityParamsSchema,
  ActivitySchema,
  type CalendarQuery,
  CalendarQuerySchema,
  type CancelActivityInput,
  CancelActivitySchema,
  type ClubCalendarQuery,
  ClubCalendarQuerySchema,
  ClubParamsSchema,
  type CreateActivityInput,
  CreateActivitySchema,
  type CreateSeriesInput,
  CreateSeriesSchema,
  type GroupCalendar,
  GroupCalendarSchema,
  GroupParamsSchema,
  type Location,
  type LocationConflicts,
  LocationConflictsQuerySchema,
  LocationConflictsSchema,
  type LocationInput,
  LocationInputSchema,
  type LocationList,
  LocationListQuerySchema,
  LocationListSchema,
  LocationParamsSchema,
  LocationSchema,
  mapUrlOf,
  type Series,
  type SeriesChangeResult,
  SeriesChangeResultSchema,
  SeriesParamsSchema,
  type SeriesPreviewInput,
  type SeriesPreviewResult,
  SeriesPreviewResultSchema,
  SeriesPreviewSchema,
  SeriesSchema,
  type SplitSeriesInput,
  SplitSeriesSchema,
  type UpdateActivityInput,
  UpdateActivitySchema,
  type UpdateLocationInput,
  UpdateLocationSchema,
  type UpdateSeriesInput,
  UpdateSeriesSchema,
  z,
} from "@clubadmin/shared";
import { Body, Controller, Param, Query } from "@nestjs/common";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  AuthorizationService,
  canManageGroupActivities,
  CurrentAuthorization,
  type GroupRef,
  LEADER_FUNCTIONS,
  permits,
  PersonPresenter,
  type RequestAuthorization,
  resourceOf,
  tenantContext,
} from "../authorization/index.ts";
import { MembershipsService } from "../memberships/index.ts";
import { PeopleService } from "../people/index.ts";
import {
  ActivitiesService,
  type ActivityView,
  type Location as LocationRow,
  type SeriesChange,
  type SeriesView,
} from "./activities.service.ts";
import { AttendanceService } from "./attendance.service.ts";

const iso = (date: Date) => date.toISOString();

export function toLocationResponse(location: LocationRow, canEdit?: boolean): Location {
  return {
    id: location.id,
    name: location.name,
    street: location.street,
    postalCode: location.postalCode,
    city: location.city,
    latitude: location.latitude,
    longitude: location.longitude,
    directions: location.directions,
    mapUrl: mapUrlOf(location),
    archived: location.archivedAt !== null,
    ...(canEdit === undefined ? {} : { canEdit }),
  };
}

/** Club managers change every location; others only those they added (P1.6b). */
const canEditLocation = (authz: RequestAuthorization, location: LocationRow) =>
  authz.actor.isClubManager(location.clubId) ||
  (location.createdByPersonId !== null && location.createdByPersonId === authz.actor.personId);

export function toActivityResponse(view: ActivityView, canManage: boolean): Activity {
  const a = view.activity;
  return {
    id: a.id,
    clubId: a.clubId,
    timeZone: view.timeZone,
    seriesId: a.seriesId,
    kind: a.kind,
    kindLabel: a.kindLabel,
    title: a.title,
    status: a.status,
    cancelledReason: a.cancelledReason,
    startsAt: iso(a.startsAt),
    endsAt: iso(a.endsAt),
    allDay: a.allDay,
    meetAt: a.meetAt ? iso(a.meetAt) : null,
    meetPlace: a.meetPlace,
    location: view.location ? toLocationResponse(view.location) : null,
    locationText: a.locationText,
    notes: a.notes,
    ...(canManage ? { leaderNotes: a.leaderNotes } : {}),
    opponent: a.opponent,
    homeAway: a.homeAway,
    competition: a.competition,
    detached: a.detached,
    sequence: a.sequence,
    changedAt: iso(a.changedAt),
    groups: view.groups,
    canManage,
    responseMode: a.responseMode,
    respondBy: a.respondBy ? iso(a.respondBy) : null,
    inviteesOnly: a.inviteesOnly,
  };
}

function toSeriesResponse(view: SeriesView, canManage: boolean): Series {
  const s = view.series;
  return {
    id: s.id,
    clubId: s.clubId,
    timeZone: view.timeZone,
    kind: s.kind,
    title: s.title,
    notes: s.notes,
    ...(canManage ? { leaderNotes: s.leaderNotes } : {}),
    location: view.location ? toLocationResponse(view.location) : null,
    locationText: s.locationText,
    slots: s.slots,
    startsOn: s.startsOn,
    endsOn: s.endsOn,
    skipDates: s.skipDates,
    skipPublicHolidays: s.skipPublicHolidays,
    responseMode: s.responseMode,
    respondByMinutes: s.respondByMinutes,
    groups: view.groups,
    sessions: view.sessions,
    canManage,
  };
}

const toChangeResponse = (change: SeriesChange): SeriesChangeResult => ({
  series: toSeriesResponse(change.series, true),
  created: change.created,
  updated: change.updated,
  removed: change.removed,
});

@Controller()
export class ActivitiesController {
  private readonly activities: ActivitiesService;
  private readonly attendance: AttendanceService;
  private readonly authorization: AuthorizationService;
  private readonly memberships: MembershipsService;
  private readonly people: PeopleService;
  private readonly presenter: PersonPresenter;

  constructor(
    activities: ActivitiesService,
    attendance: AttendanceService,
    authorization: AuthorizationService,
    memberships: MembershipsService,
    people: PeopleService,
    presenter: PersonPresenter,
  ) {
    this.activities = activities;
    this.attendance = attendance;
    this.authorization = authorization;
    this.memberships = memberships;
    this.people = people;
    this.presenter = presenter;
  }

  // --- Locations -------------------------------------------------------------------

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/locations",
    summary: "The club's locations by name (archived ones with archived=true)",
    tags: ["activities"],
    access: { permission: "club.read", resource: "club" },
    request: { params: ClubParamsSchema, query: LocationListQuerySchema },
    response: LocationListSchema,
  })
  async listLocations(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: z.infer<typeof LocationListQuerySchema>,
  ): Promise<LocationList> {
    const { clubId } = resourceOf(authz, "club");
    const page = await this.activities.listLocations(tenantContext(authz, clubId), query);
    return {
      items: page.items.map((l) => toLocationResponse(l, canEditLocation(authz, l))),
      nextCursor: page.nextCursor,
    };
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/locations",
    summary: "Add a location (hall, pitch): club managers and those who plan a group's activities",
    tags: ["activities"],
    access: { permission: "club.locations.create", resource: "club" },
    request: { params: ClubParamsSchema, body: LocationInputSchema },
    response: LocationSchema,
  })
  async createLocation(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: LocationInput,
  ): Promise<Location> {
    const { clubId } = resourceOf(authz, "club");
    return toLocationResponse(
      await this.activities.createLocation(tenantContext(authz, clubId), body),
      true,
    );
  }

  @Endpoint({
    method: "PATCH",
    path: "clubs/:clubId/locations/:locationId",
    summary: "Change or archive a location (club managers, or the person who added it)",
    tags: ["activities"],
    access: { permission: "club.locations.create", resource: "club" },
    request: { params: LocationParamsSchema, body: UpdateLocationSchema },
    response: LocationSchema,
  })
  async updateLocation(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof LocationParamsSchema>,
    @Body() body: UpdateLocationInput,
  ): Promise<Location> {
    const { clubId } = resourceOf(authz, "club");
    return toLocationResponse(
      await this.activities.updateLocation(tenantContext(authz, clubId), params.locationId, body, {
        anyLocation: authz.actor.isClubManager(clubId),
      }),
      true,
    );
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/locations/:locationId/conflicts",
    summary: "Overlapping scheduled activities at a location (double bookings)",
    tags: ["activities"],
    access: { permission: "club.activities.read", resource: "club" },
    request: { params: LocationParamsSchema, query: LocationConflictsQuerySchema },
    response: LocationConflictsSchema,
  })
  async locationConflicts(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof LocationParamsSchema>,
    @Query() query: z.infer<typeof LocationConflictsQuerySchema>,
  ): Promise<LocationConflicts> {
    const { clubId } = resourceOf(authz, "club");
    const pairs = await this.activities.locationConflicts(
      tenantContext(authz, clubId),
      params.locationId,
      query,
    );
    const manage = await this.manageCheck(authz, clubId, pairs.flat());
    return {
      conflicts: pairs.map(([first, second]) => ({
        first: toActivityResponse(first, manage(first)),
        second: toActivityResponse(second, manage(second)),
      })),
    };
  }

  // --- Calendars --------------------------------------------------------------------

  @Endpoint({
    method: "GET",
    path: "groups/:groupId/activities",
    summary: "The group's calendar: its activities in a time range (at most 400 days)",
    tags: ["activities"],
    access: { permission: "group.activities.read", resource: "group" },
    request: { params: GroupParamsSchema, query: CalendarQuerySchema },
    response: GroupCalendarSchema,
  })
  async groupCalendar(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: CalendarQuery,
  ): Promise<GroupCalendar> {
    const group = resourceOf(authz, "group");
    const page = await this.activities.groupCalendar(
      tenantContext(authz, group.clubId),
      group.groupId,
      query,
    );
    const manage = await this.manageCheck(authz, group.clubId, page.items);
    // Answers so far, for those who manage an activity (one grouped statement).
    const managed = page.items.filter((v) => manage(v) && v.activity.responseMode !== "none");
    const counts = await this.attendance.countsFor(
      tenantContext(authz, group.clubId),
      managed.map((v) => v.activity.id),
    );
    return {
      items: page.items.map((v) => {
        const responseCounts = counts.get(v.activity.id);
        return {
          ...toActivityResponse(v, manage(v)),
          ...(responseCounts ? { responseCounts } : {}),
        };
      }),
      nextCursor: page.nextCursor,
      canManage: !group.archived && canManageGroupActivities(authz.actor, group),
      canReadAttendance: permits(authz.actor, "group.attendance.read", group),
    };
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/activities",
    summary: "The club calendar: every activity in a time range, by group or location",
    tags: ["activities"],
    access: { permission: "club.activities.read", resource: "club" },
    request: { params: ClubParamsSchema, query: ClubCalendarQuerySchema },
    response: ActivityPageSchema,
  })
  async clubCalendar(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: ClubCalendarQuery,
  ): Promise<ActivityPage> {
    const { clubId } = resourceOf(authz, "club");
    const page = await this.activities.clubCalendar(tenantContext(authz, clubId), query);
    const manage = await this.manageCheck(authz, clubId, page.items);
    return {
      items: page.items.map((v) => toActivityResponse(v, manage(v))),
      nextCursor: page.nextCursor,
    };
  }

  // --- Single activities ---------------------------------------------------------------

  @Endpoint({
    method: "POST",
    path: "groups/:groupId/activities",
    summary: "Add a match, meeting or other activity (with groupIds: a joint one)",
    tags: ["activities"],
    access: { permission: "group.activities.manage", resource: "group" },
    request: { params: GroupParamsSchema, body: CreateActivitySchema },
    response: ActivitySchema,
  })
  async createActivity(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: CreateActivityInput,
  ): Promise<Activity> {
    const group = resourceOf(authz, "group");
    await this.requireManaged(authz, group.clubId, body.groupIds ?? []);
    const view = await this.activities.createActivity(
      tenantContext(authz, group.clubId),
      group.groupId,
      body,
    );
    return toActivityResponse(view, true);
  }

  @Endpoint({
    method: "GET",
    path: "activities/:activityId",
    summary: "An activity with the leaders of its groups (never its participants)",
    tags: ["activities"],
    access: { permission: "activity.read", resource: "activity" },
    request: { params: ActivityParamsSchema },
    response: ActivityDetailSchema,
  })
  async getActivity(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof ActivityParamsSchema>,
  ): Promise<ActivityDetail> {
    const resource = resourceOf(authz, "activity");
    const context = tenantContext(authz, resource.clubId);
    const view = await this.activities.getActivity(context, params.activityId);
    const members = (
      await Promise.all(view.groups.map((g) => this.memberships.groupMembers(context, g.id)))
    ).flat();
    const leaderIds = [
      ...new Set(
        members.filter((m) => LEADER_FUNCTIONS.includes(m.function)).map((m) => m.personId),
      ),
    ];
    const leaders = await this.presenter.present(
      authz,
      resource.clubId,
      await this.people.summaries(context, leaderIds),
    );
    return { ...toActivityResponse(view, this.managesAll(authz, resource.groups)), leaders };
  }

  @Endpoint({
    method: "PATCH",
    path: "activities/:activityId",
    summary: "Change an activity (a series session becomes detached from its series)",
    tags: ["activities"],
    access: { permission: "activity.manage", resource: "activity" },
    request: { params: ActivityParamsSchema, body: UpdateActivitySchema },
    response: ActivitySchema,
  })
  async updateActivity(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof ActivityParamsSchema>,
    @Body() body: UpdateActivityInput,
  ): Promise<Activity> {
    const { clubId } = resourceOf(authz, "activity");
    const view = await this.activities.updateActivity(
      tenantContext(authz, clubId),
      params.activityId,
      body,
    );
    return toActivityResponse(view, true);
  }

  @Endpoint({
    method: "POST",
    path: "activities/:activityId/cancel",
    summary: "Cancel an activity (it stays in calendars, marked cancelled)",
    tags: ["activities"],
    access: { permission: "activity.manage", resource: "activity" },
    request: { params: ActivityParamsSchema, body: CancelActivitySchema },
    response: ActivitySchema,
    status: 200,
  })
  async cancelActivity(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof ActivityParamsSchema>,
    @Body() body: CancelActivityInput,
  ): Promise<Activity> {
    const { clubId } = resourceOf(authz, "activity");
    const view = await this.activities.cancelActivity(
      tenantContext(authz, clubId),
      params.activityId,
      body,
    );
    return toActivityResponse(view, true);
  }

  @Endpoint({
    method: "POST",
    path: "activities/:activityId/restore",
    summary: "Restore a cancelled activity",
    tags: ["activities"],
    access: { permission: "activity.manage", resource: "activity" },
    request: { params: ActivityParamsSchema },
    response: ActivitySchema,
    status: 200,
  })
  async restoreActivity(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof ActivityParamsSchema>,
  ): Promise<Activity> {
    const { clubId } = resourceOf(authz, "activity");
    const view = await this.activities.restoreActivity(
      tenantContext(authz, clubId),
      params.activityId,
    );
    return toActivityResponse(view, true);
  }

  @Endpoint({
    method: "DELETE",
    path: "activities/:activityId",
    summary: "Delete an activity (a series session: its date is skipped from then on)",
    tags: ["activities"],
    access: { permission: "activity.manage", resource: "activity" },
    request: { params: ActivityParamsSchema },
    response: z.null(),
    status: 204,
  })
  async deleteActivity(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof ActivityParamsSchema>,
  ): Promise<null> {
    const { clubId } = resourceOf(authz, "activity");
    await this.activities.deleteActivity(tenantContext(authz, clubId), params.activityId);
    return null;
  }

  // --- Series ---------------------------------------------------------------------------

  @Endpoint({
    method: "POST",
    path: "groups/:groupId/activity-series/preview",
    summary: "The sessions a weekly series would have (nothing is stored)",
    tags: ["activities"],
    access: { permission: "group.activities.manage", resource: "group" },
    request: { params: GroupParamsSchema, body: SeriesPreviewSchema },
    response: SeriesPreviewResultSchema,
    status: 200,
  })
  async previewSeries(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: SeriesPreviewInput,
  ): Promise<SeriesPreviewResult> {
    const { clubId } = resourceOf(authz, "group");
    const preview = await this.activities.previewSeries(tenantContext(authz, clubId), body);
    return {
      timeZone: preview.timeZone,
      sessions: preview.sessions.map((s) => ({
        date: s.date,
        startsAt: iso(s.startsAt),
        endsAt: iso(s.endsAt),
      })),
      skipped: preview.skipped,
    };
  }

  @Endpoint({
    method: "POST",
    path: "groups/:groupId/activity-series",
    summary: "Add a weekly series of trainings (all its sessions are created at once)",
    tags: ["activities"],
    access: { permission: "group.activities.manage", resource: "group" },
    request: { params: GroupParamsSchema, body: CreateSeriesSchema },
    response: SeriesChangeResultSchema,
  })
  async createSeries(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: CreateSeriesInput,
  ): Promise<SeriesChangeResult> {
    const group = resourceOf(authz, "group");
    await this.requireManaged(authz, group.clubId, body.groupIds ?? []);
    return toChangeResponse(
      await this.activities.createSeries(tenantContext(authz, group.clubId), group.groupId, body),
    );
  }

  @Endpoint({
    method: "GET",
    path: "activity-series/:seriesId",
    summary: "A series and its rules",
    tags: ["activities"],
    access: { permission: "activity.read", resource: "activity" },
    request: { params: SeriesParamsSchema },
    response: SeriesSchema,
  })
  async getSeries(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof SeriesParamsSchema>,
  ): Promise<Series> {
    const resource = resourceOf(authz, "activity");
    const view = await this.activities.getSeries(
      tenantContext(authz, resource.clubId),
      params.seriesId,
    );
    return toSeriesResponse(view, this.managesAll(authz, resource.groups));
  }

  @Endpoint({
    method: "PATCH",
    path: "activity-series/:seriesId",
    summary: "Change a series from a date (default today); detached sessions stay as they are",
    tags: ["activities"],
    access: { permission: "activity.manage", resource: "activity" },
    request: { params: SeriesParamsSchema, body: UpdateSeriesSchema },
    response: SeriesChangeResultSchema,
  })
  async updateSeries(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof SeriesParamsSchema>,
    @Body() body: UpdateSeriesInput,
  ): Promise<SeriesChangeResult> {
    const { clubId } = resourceOf(authz, "activity");
    return toChangeResponse(
      await this.activities.updateSeries(tenantContext(authz, clubId), params.seriesId, body),
    );
  }

  @Endpoint({
    method: "POST",
    path: "activity-series/:seriesId/split",
    summary: "This and following sessions: a new series with the changes from a session on",
    tags: ["activities"],
    access: { permission: "activity.manage", resource: "activity" },
    request: { params: SeriesParamsSchema, body: SplitSeriesSchema },
    response: SeriesChangeResultSchema,
  })
  async splitSeries(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof SeriesParamsSchema>,
    @Body() body: SplitSeriesInput,
  ): Promise<SeriesChangeResult> {
    const { clubId } = resourceOf(authz, "activity");
    return toChangeResponse(
      await this.activities.splitSeries(tenantContext(authz, clubId), params.seriesId, body),
    );
  }

  // --- Helpers -----------------------------------------------------------------------

  private managesAll(authz: RequestAuthorization, groups: readonly GroupRef[]): boolean {
    return groups.length > 0 && groups.every((g) => canManageGroupActivities(authz.actor, g));
  }

  /** Whether the viewer manages each activity (all of its groups), with one lookup. */
  private async manageCheck(
    authz: RequestAuthorization,
    clubId: string,
    views: readonly ActivityView[],
  ): Promise<(view: ActivityView) => boolean> {
    const refs = new Map(
      (
        await this.authorization.groupRefs(
          authz,
          clubId,
          views.flatMap((v) => v.groups.map((g) => g.id)),
        )
      ).map((r) => [r.groupId, r]),
    );
    return (view) =>
      this.managesAll(
        authz,
        view.groups.flatMap((g) => {
          const ref = refs.get(g.id);
          return ref ? [ref] : [];
        }),
      ) && view.groups.every((g) => refs.has(g.id));
  }

  /** The other groups of a joint activity or series: the actor must manage each. */
  private async requireManaged(
    authz: RequestAuthorization,
    clubId: string,
    groupIds: readonly string[],
  ): Promise<void> {
    if (groupIds.length === 0) return;
    const refs = await this.authorization.groupRefs(authz, clubId, groupIds);
    if (refs.length !== new Set(groupIds).size) throw new DomainError("not_found");
    if (refs.some((r) => r.archived)) throw new DomainError("group_archived");
    if (!refs.every((r) => canManageGroupActivities(authz.actor, r))) {
      throw new DomainError("group_not_managed");
    }
  }
}
