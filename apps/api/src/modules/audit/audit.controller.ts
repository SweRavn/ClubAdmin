// SPDX-License-Identifier: AGPL-3.0-only
// History panels, the club-wide changes and the club's audit log (P1.9,
// ADR 0042). Reads only, for club managers and registrars (the audit log
// and the club-wide changes: club managers with a second factor), each with
// a per-account rate limit. Allowed for clubs in any access state.

import {
  ActivityParamsSchema,
  AuditEventsQuerySchema,
  type AuditPage,
  AuditPageSchema,
  ClubHistoryQuerySchema,
  ClubParamsSchema,
  EventParamsSchema,
  GroupParamsSchema,
  type HistoryPage,
  HistoryPageSchema,
  HistoryQuerySchema,
  PersonHistoryQuerySchema,
  PersonParamsSchema,
  SeriesParamsSchema,
  z,
} from "@clubadmin/shared";
import { Controller, Param, Query } from "@nestjs/common";

import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  CurrentAuthorization,
  type RequestAuthorization,
  resourceOf,
} from "../authorization/index.ts";
import { HistoryService } from "./history.service.ts";

const TAGS = ["history"];

@Controller()
export class AuditController {
  private readonly history: HistoryService;

  constructor(history: HistoryService) {
    this.history = history;
  }

  @Endpoint({
    method: "GET",
    path: "people/:personId/history",
    summary: "A member's history in a club (club managers and registrars)",
    tags: TAGS,
    access: { permission: "person.history.read", resource: "person" },
    request: { params: PersonParamsSchema, query: PersonHistoryQuerySchema },
    response: HistoryPageSchema,
    accountLimit: "history",
    clubAccess: "export",
  })
  personHistory(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: z.infer<typeof PersonHistoryQuerySchema>,
  ): Promise<HistoryPage> {
    const resource = resourceOf(authz, "person");
    return this.history.panel(
      authz,
      {
        kind: "person",
        clubId: query.clubId,
        id: resource.personId,
        sharedFields: resource.inClub?.sharedFields ?? [],
        protectedPerson: resource.inClub?.protected === true,
      },
      query,
    );
  }

  @Endpoint({
    method: "GET",
    path: "groups/:groupId/history",
    summary: "A group's history (club managers and registrars)",
    tags: TAGS,
    access: { permission: "group.history.read", resource: "group" },
    request: { params: GroupParamsSchema, query: HistoryQuerySchema },
    response: HistoryPageSchema,
    accountLimit: "history",
    clubAccess: "export",
  })
  groupHistory(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: z.infer<typeof HistoryQuerySchema>,
  ): Promise<HistoryPage> {
    const group = resourceOf(authz, "group");
    return this.history.panel(
      authz,
      { kind: "group", clubId: group.clubId, id: group.groupId },
      query,
    );
  }

  @Endpoint({
    method: "GET",
    path: "activities/:activityId/history",
    summary:
      "An activity's history: changes, answers and attendance (club managers and registrars)",
    tags: TAGS,
    access: { permission: "activity.history.read", resource: "activity" },
    request: { params: ActivityParamsSchema, query: HistoryQuerySchema },
    response: HistoryPageSchema,
    accountLimit: "history",
    clubAccess: "export",
  })
  activityHistory(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof ActivityParamsSchema>,
    @Query() query: z.infer<typeof HistoryQuerySchema>,
  ): Promise<HistoryPage> {
    const activity = resourceOf(authz, "activity");
    return this.history.panel(
      authz,
      { kind: "activity", clubId: activity.clubId, id: params.activityId, activity },
      query,
    );
  }

  @Endpoint({
    method: "GET",
    path: "activity-series/:seriesId/history",
    summary: "An activity series' history (club managers and registrars)",
    tags: TAGS,
    access: { permission: "activity.history.read", resource: "activity" },
    request: { params: SeriesParamsSchema, query: HistoryQuerySchema },
    response: HistoryPageSchema,
    accountLimit: "history",
    clubAccess: "export",
  })
  seriesHistory(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof SeriesParamsSchema>,
    @Query() query: z.infer<typeof HistoryQuerySchema>,
  ): Promise<HistoryPage> {
    const activity = resourceOf(authz, "activity");
    return this.history.panel(
      authz,
      { kind: "series", clubId: activity.clubId, id: params.seriesId, activity },
      query,
    );
  }

  @Endpoint({
    method: "GET",
    path: "events/:eventId/history",
    summary: "An event's history: changes and registrations (club managers and registrars)",
    tags: TAGS,
    access: { permission: "event.history.read", resource: "event" },
    request: { params: EventParamsSchema, query: HistoryQuerySchema },
    response: HistoryPageSchema,
    accountLimit: "history",
    clubAccess: "export",
  })
  eventHistory(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof EventParamsSchema>,
    @Query() query: z.infer<typeof HistoryQuerySchema>,
  ): Promise<HistoryPage> {
    const event = resourceOf(authz, "event");
    return this.history.panel(
      authz,
      { kind: "event", clubId: event.clubId, id: params.eventId },
      query,
    );
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/history",
    summary:
      "The club's changes, newest first; by kind of record or person acting within at most 90 days (club managers)",
    tags: TAGS,
    access: { permission: "club.history.read", resource: "club" },
    request: { params: ClubParamsSchema, query: ClubHistoryQuerySchema },
    response: HistoryPageSchema,
    accountLimit: "history",
    clubAccess: "export",
  })
  clubHistory(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: z.infer<typeof ClubHistoryQuerySchema>,
  ): Promise<HistoryPage> {
    const { clubId } = resourceOf(authz, "club");
    if (query.scope === "club") {
      return this.history.panel(authz, { kind: "club", clubId, id: clubId }, query);
    }
    return this.history.clubHistory(authz, clubId, query);
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/audit-events",
    summary: "The club's audit log: who did what, when (club managers)",
    tags: TAGS,
    access: { permission: "club.audit.read", resource: "club" },
    request: { params: ClubParamsSchema, query: AuditEventsQuerySchema },
    response: AuditPageSchema,
    accountLimit: "history",
    clubAccess: "export",
  })
  auditEvents(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: z.infer<typeof AuditEventsQuerySchema>,
  ): Promise<AuditPage> {
    const { clubId } = resourceOf(authz, "club");
    return this.history.auditEvents(authz, clubId, query);
  }
}
