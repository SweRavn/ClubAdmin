// SPDX-License-Identifier: AGPL-3.0-only
// Calendar subscriptions (P1.11, ADR 0044): managing one's own feeds (login,
// own data), creating a group's or club's feed (the calendar's read
// permission and the calendar_feeds entitlement), the answer links of feed
// events (public, by signed token) and the feed itself (GET /cal/<secret>.ics,
// outside /api/v1).

import {
  CALENDAR_FEEDS_MAX,
  type CalendarAnswer,
  CalendarAnswerParamsSchema,
  CalendarAnswerResultSchema,
  CalendarAnswerSchema,
  type CalendarFeed,
  type CalendarFeedCreated,
  CalendarFeedCreatedSchema,
  type CalendarFeedList,
  CalendarFeedListSchema,
  CalendarFeedParamsSchema,
  CalendarFeedSchema,
  ClubParamsSchema,
  type CreateMyScheduleFeedInput,
  CreateMyScheduleFeedSchema,
  type CreateScopedFeedInput,
  CreateScopedFeedSchema,
  GroupParamsSchema,
  OkSchema,
  type UpdateCalendarFeedInput,
  UpdateCalendarFeedSchema,
  z,
} from "@clubadmin/shared";
import { Body, Controller, Headers, Param, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  CurrentAuthorization,
  type RequestAuthorization,
  resourceOf,
} from "../authorization/index.ts";
import { RequiresEntitlement } from "../entitlements/index.ts";
import type { FeedRow } from "./calendar.repository.ts";
import { CalendarService, type FeedView } from "./calendar.service.ts";
import { shownName } from "./presenters/shown-name.presenter.ts";

const iso = (d: Date | null) => (d ? d.toISOString() : null);

const view = (f: FeedView): CalendarFeed => ({
  id: f.id,
  scope: f.scope,
  club: f.club,
  group: f.group,
  people: f.people,
  everyone: f.scope === "my_schedule" && f.personIds.length === 0,
  label: f.label,
  createdAt: f.createdAt.toISOString(),
  lastFetchedAt: iso(f.lastFetchedAt),
});

/** Per IP: calendar apps poll; guessing costs the IP double (in the service). */
const FEED_IP_LIMIT = { max: 300, timeWindowMs: 60_000 };
const ANSWER_IP_LIMIT = { max: 20, timeWindowMs: 60_000 };

@Controller()
export class CalendarController {
  private readonly calendar: CalendarService;

  constructor(calendar: CalendarService) {
    this.calendar = calendar;
  }

  /** The created feed as the caller's list shows it, with its URLs (shown once). */
  private async created(
    authz: RequestAuthorization,
    result: { feed: FeedRow; secret: string },
  ): Promise<CalendarFeedCreated> {
    const feed = (await this.calendar.list(authz)).find((f) => f.id === result.feed.id);
    return { feed: view(feed!), ...this.calendar.urls(result.secret) };
  }

  @Endpoint({
    method: "GET",
    path: "me/calendar-feeds",
    summary: "My calendar subscriptions (never their secrets)",
    tags: ["me", "calendar"],
    access: { authenticated: true },
    response: CalendarFeedListSchema,
  })
  async list(@CurrentAuthorization() authz: RequestAuthorization): Promise<CalendarFeedList> {
    return { items: (await this.calendar.list(authz)).map(view), max: CALENDAR_FEEDS_MAX };
  }

  @Endpoint({
    method: "POST",
    path: "me/calendar-feeds",
    summary:
      "Subscribe to my schedule (and chosen children's) in a calendar app; the URL is shown once",
    tags: ["me", "calendar"],
    access: { authenticated: true },
    request: { body: CreateMyScheduleFeedSchema },
    response: CalendarFeedCreatedSchema,
  })
  async create(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: CreateMyScheduleFeedInput,
  ): Promise<CalendarFeedCreated> {
    return this.created(authz, await this.calendar.createMySchedule(authz, body));
  }

  @Endpoint({
    method: "POST",
    path: "groups/:groupId/calendar-feeds",
    summary: "Subscribe to a group's calendar; the URL is shown once",
    tags: ["groups", "calendar"],
    access: { permission: "group.activities.read", resource: "group" },
    request: { params: GroupParamsSchema, body: CreateScopedFeedSchema },
    response: CalendarFeedCreatedSchema,
  })
  @RequiresEntitlement("calendar_feeds")
  async createGroupFeed(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: CreateScopedFeedInput,
  ): Promise<CalendarFeedCreated> {
    const group = resourceOf(authz, "group");
    return this.created(
      authz,
      await this.calendar.createScoped(
        authz,
        { clubId: group.clubId, groupId: group.groupId },
        body.label,
      ),
    );
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/calendar-feeds",
    summary: "Subscribe to the club's calendar (all groups); the URL is shown once",
    tags: ["clubs", "calendar"],
    access: { permission: "club.activities.read", resource: "club" },
    request: { params: ClubParamsSchema, body: CreateScopedFeedSchema },
    response: CalendarFeedCreatedSchema,
  })
  @RequiresEntitlement("calendar_feeds")
  async createClubFeed(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: CreateScopedFeedInput,
  ): Promise<CalendarFeedCreated> {
    const { clubId } = resourceOf(authz, "club");
    return this.created(
      authz,
      await this.calendar.createScoped(authz, { clubId, groupId: null }, body.label),
    );
  }

  @Endpoint({
    method: "PATCH",
    path: "me/calendar-feeds/:feedId",
    summary: "Rename a subscription or change whose activities it shows",
    tags: ["me", "calendar"],
    access: { authenticated: true },
    request: { params: CalendarFeedParamsSchema, body: UpdateCalendarFeedSchema },
    response: CalendarFeedSchema,
  })
  async update(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("feedId") feedId: string,
    @Body() body: UpdateCalendarFeedInput,
  ): Promise<CalendarFeed> {
    await this.calendar.update(authz, feedId, body);
    const feed = (await this.calendar.list(authz)).find((f) => f.id === feedId);
    return view(feed!);
  }

  @Endpoint({
    method: "POST",
    path: "me/calendar-feeds/:feedId/regenerate",
    summary: "Replace a subscription's link (the old one stops working); the new URL is shown once",
    tags: ["me", "calendar"],
    access: { authenticated: true },
    request: { params: CalendarFeedParamsSchema },
    response: CalendarFeedCreatedSchema,
    status: 200,
  })
  async regenerate(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("feedId") feedId: string,
  ): Promise<CalendarFeedCreated> {
    return this.created(authz, await this.calendar.regenerate(authz, feedId));
  }

  @Endpoint({
    method: "DELETE",
    path: "me/calendar-feeds/:feedId",
    summary: "Remove a subscription: its link and answer links stop working at once",
    tags: ["me", "calendar"],
    access: { authenticated: true },
    request: { params: CalendarFeedParamsSchema },
    response: OkSchema,
  })
  async revoke(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("feedId") feedId: string,
  ): Promise<{ ok: true }> {
    await this.calendar.revoke(authz, feedId);
    return { ok: true };
  }

  // --- Answer links (public, by signed token) -----------------------------------------

  @Endpoint({
    method: "GET",
    path: "calendar-answers/:token",
    summary: "What a calendar answer link would answer (changes nothing)",
    tags: ["calendar"],
    access: { public: true },
    request: { params: CalendarAnswerParamsSchema },
    response: CalendarAnswerSchema,
    rateLimit: ANSWER_IP_LIMIT,
  })
  async answerInfo(
    @Param("token") token: string,
    @Req() request: FastifyRequest,
  ): Promise<CalendarAnswer> {
    const info = await this.calendar.answerInfo(token, request.ip, request.id);
    const row = info.entry.row;
    return {
      activity: {
        title: row.title,
        startsAt: row.startsAt.toISOString(),
        place: row.place,
        clubName: info.entry.club.name,
        timeZone: info.entry.club.timeZone,
        cancelled: row.status === "cancelled",
      },
      personName: shownName(info.person),
      status: info.link.status,
      currentAnswer: (row.answers[info.link.personId] ?? null) as CalendarAnswer["currentAnswer"],
      open: info.state.open,
      deadlinePassed: info.state.deadlinePassed,
      respondBy: iso(row.respondBy),
    };
  }

  @Endpoint({
    method: "POST",
    path: "calendar-answers/:token",
    summary: "Answer from a calendar's answer link, as the subscription's owner",
    tags: ["calendar"],
    access: { public: true },
    request: { params: CalendarAnswerParamsSchema },
    response: CalendarAnswerResultSchema,
    status: 200,
    rateLimit: ANSWER_IP_LIMIT,
  })
  async answer(
    @Param("token") token: string,
    @Req() request: FastifyRequest,
  ): Promise<{ status: "attending" | "not_attending" }> {
    return { status: await this.calendar.answer(token, request.ip, request.id) };
  }

  // --- The feed (GET /cal/<secret>.ics, outside /api/v1) ------------------------------

  @Endpoint({
    method: "GET",
    path: "cal/:file",
    summary: "A calendar subscription as iCalendar (RFC 5545); the secret is the file name",
    tags: ["calendar"],
    access: { public: true },
    request: { params: z.object({ file: z.string().max(200) }) },
    response: z.string(),
    responseType: "text/calendar",
    rateLimit: FEED_IP_LIMIT,
  })
  async feed(
    @Param("file") file: string,
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<string> {
    const secret = file.endsWith(".ics") ? file.slice(0, -4) : file;
    const result = await this.calendar.fetch(secret, request.ip, ifNoneMatch, request.id);
    void reply.header("cache-control", "private, max-age=300");
    void reply.header("referrer-policy", "no-referrer");
    if (result.status === 404) {
      void reply.code(404).header("content-type", "text/plain; charset=utf-8");
      return "";
    }
    void reply.header("etag", result.etag!);
    if (result.status === 304) {
      void reply.code(304);
      return "";
    }
    void reply.header("content-type", "text/calendar; charset=utf-8");
    void reply.header("last-modified", result.lastModified!.toUTCString());
    return result.body!;
  }
}
