// SPDX-License-Identifier: AGPL-3.0-only
// Events with sign-up (P1.6, ADR 0038). Who may sign up whom (the caller,
// wards with sign_up), who is in the audience, who sees sealed answers and
// who may see participants' names are decided here from the actor and the
// event; the service decides places, the queue and deadlines. People go
// through the PersonPresenter: protected participants are counted, never
// named, for viewers who may not see them.

import {
  type Answers,
  CancelEventSchema,
  ClubParamsSchema,
  type CreateEventInput,
  CreateEventSchema,
  type Event,
  type EventDetail,
  EventDetailSchema,
  type EventListQuery,
  EventListQuerySchema,
  type EventPage,
  EventPageSchema,
  EventParamsSchema,
  EventSchema,
  GroupParamsSchema,
  type MyEvents,
  MyEventsSchema,
  PageQuerySchema,
  type PersonSummary,
  type RegisterInput,
  RegisterSchema,
  type Registration,
  RegistrationDecisionSchema,
  RegistrationExportQuerySchema,
  type RegistrationList,
  type RegistrationListQuery,
  RegistrationListQuerySchema,
  RegistrationListSchema,
  RegistrationParamsSchema,
  SetEventActivitiesSchema,
  type UpdateEventInput,
  UpdateEventSchema,
  z,
} from "@clubadmin/shared";
import { Body, Controller, Param, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { Endpoint } from "../../platform/http/endpoint.ts";
import { ProblemError } from "../../platform/http/problem-error.ts";
import { toLocationResponse } from "../activities/index.ts";
import {
  type Actor,
  AuthorizationService,
  canManageEvent,
  canManageGroupActivities,
  canReadEvent,
  canReadGroupMembers,
  CurrentAuthorization,
  type EventResource,
  type GroupRef,
  PersonPresenter,
  type RequestAuthorization,
  resourceOf,
  tenantContext,
} from "../authorization/index.ts";
import { PeopleService } from "../people/index.ts";
import {
  type EventScope,
  EventsService,
  type EventView,
  type RegistrationResult,
  type RegistrationView,
} from "./events.service.ts";

const iso = (date: Date) => date.toISOString();
const iso_ = (date: Date | null) => (date ? date.toISOString() : null);
const BOARD = [
  "chair",
  "vice_chair",
  "treasurer",
  "secretary",
  "board_member",
  "deputy_board_member",
] as const;
const MEMBER_STATUSES = ["active", "paused"];

/** Registration endpoints: a per-account budget on top of the global limit (P0.10). */
const REGISTRATION_LIMIT = { max: 60, timeWindowMs: 60_000 };

/** Whom the caller may sign up: the actor (the ward when acting for them) and wards with sign_up. */
export function signUpPeople(actor: Actor): string[] {
  if (actor.onBehalfOf) return [actor.personId];
  return [
    actor.personId,
    ...actor.relationships.wards
      .filter((w) => w.rights.includes("sign_up") || actor.isFullGuardianOf(w.personId))
      .map((w) => w.personId),
  ].filter((id, i, all) => all.indexOf(id) === i);
}

/** The caller's family on an event page: whom they may sign up or whose schedule they see. */
function familyOf(actor: Actor): string[] {
  if (actor.onBehalfOf) return [actor.personId];
  return [
    ...signUpPeople(actor),
    ...actor.relationships.wards
      .filter((w) => w.rights.includes("view_schedule"))
      .map((w) => w.personId),
  ].filter((id, i, all) => all.indexOf(id) === i);
}

/** Whether the person is in the event's audience (as the actor or one of their wards). */
function inAudience(actor: Actor, personId: string, event: EventResource): boolean {
  const r = actor.relationships;
  if (event.audience === "club") {
    return personId === actor.personId
      ? actor.isClubMember(event.clubId)
      : r.wardMemberships.some(
          (m) =>
            m.personId === personId &&
            m.clubId === event.clubId &&
            MEMBER_STATUSES.includes(m.status),
        );
  }
  const groups = new Set(event.groups.map((g) => g.groupId));
  return personId === actor.personId
    ? r.groups.some((g) => groups.has(g.groupId) && g.function === "member")
    : r.wardGroups.some(
        (g) => g.personId === personId && groups.has(g.groupId) && g.function === "member",
      );
}

/** Who sees a person's sealed answers: themselves, guardians with see_medical, organisers. */
function seesSealed(actor: Actor, personId: string, event: EventResource): boolean {
  return (
    personId === actor.personId ||
    actor.isGuardianOf(personId, "see_medical") ||
    actor.isFullGuardianOf(personId) ||
    canManageEvent(actor, event)
  );
}

@Controller()
export class EventsController {
  private readonly events: EventsService;
  private readonly people: PeopleService;
  private readonly presenter: PersonPresenter;
  private readonly authorization: AuthorizationService;

  constructor(
    events: EventsService,
    people: PeopleService,
    presenter: PersonPresenter,
    authorization: AuthorizationService,
  ) {
    this.events = events;
    this.people = people;
    this.presenter = presenter;
    this.authorization = authorization;
  }

  // --- Events -------------------------------------------------------------------------

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/events",
    summary: "The club's events the caller may see (organisers also drafts)",
    tags: ["events"],
    access: { permission: "club.events.read", resource: "club" },
    request: { params: ClubParamsSchema, query: EventListQuerySchema },
    response: EventPageSchema,
  })
  async clubEvents(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof ClubParamsSchema>,
    @Query() query: EventListQuery,
  ): Promise<EventPage> {
    return this.page(authz, params.clubId, null, query);
  }

  @Endpoint({
    method: "GET",
    path: "groups/:groupId/events",
    summary: "The group's events",
    tags: ["events"],
    access: { permission: "group.activities.read", resource: "group" },
    request: { params: GroupParamsSchema, query: EventListQuerySchema },
    response: EventPageSchema,
  })
  async groupEvents(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof GroupParamsSchema>,
    @Query() query: EventListQuery,
  ): Promise<EventPage> {
    const { clubId } = resourceOf(authz, "group");
    return this.page(authz, clubId, params.groupId, query);
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/events",
    summary: "Create an event for groups the caller manages, or for the whole club",
    tags: ["events"],
    access: { permission: "club.events.create", resource: "club" },
    request: { params: ClubParamsSchema, body: CreateEventSchema },
    response: EventSchema,
  })
  async create(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof ClubParamsSchema>,
    @Body() body: CreateEventInput,
  ): Promise<Event> {
    const actor = authz.actor;
    if (body.audience === "club") {
      if (!actor.isClubManager(params.clubId) && !actor.hasClubRole(params.clubId, ...BOARD)) {
        throw new DomainError("not_allowed");
      }
    } else {
      const groupIds = [...new Set(body.groupIds ?? [])];
      const refs = await this.authorization.groupRefs(authz, params.clubId, groupIds);
      if (refs.length !== groupIds.length) throw new DomainError("not_found");
      if (refs.some((r) => r.archived)) throw new DomainError("group_archived");
      if (!refs.every((r) => canManageGroupActivities(actor, r))) {
        throw new DomainError("group_not_managed");
      }
    }
    const view = await this.events.createEvent(tenantContext(authz, params.clubId), body);
    return toEvent(view, true);
  }

  @Endpoint({
    method: "GET",
    path: "events/:eventId",
    summary: "The event, its activities, counts, the questions and my family's registrations",
    tags: ["events"],
    access: { permission: "event.read", resource: "event" },
    request: { params: EventParamsSchema },
    response: EventDetailSchema,
  })
  get(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof EventParamsSchema>,
  ): Promise<EventDetail> {
    return this.detail(authz, params.eventId);
  }

  @Endpoint({
    method: "PATCH",
    path: "events/:eventId",
    summary: "Change the event (the capacity cannot go below the confirmed count)",
    tags: ["events"],
    access: { permission: "event.manage", resource: "event" },
    request: { params: EventParamsSchema, body: UpdateEventSchema },
    response: EventSchema,
  })
  async update(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof EventParamsSchema>,
    @Body() body: UpdateEventInput,
  ): Promise<Event> {
    const { clubId } = resourceOf(authz, "event");
    return toEvent(
      await this.events.updateEvent(tenantContext(authz, clubId), params.eventId, body),
      true,
    );
  }

  @Endpoint({
    method: "POST",
    path: "events/:eventId/publish",
    summary: "Publish a draft: the audience sees it and may sign up when it opens",
    tags: ["events"],
    access: { permission: "event.manage", resource: "event" },
    request: { params: EventParamsSchema },
    response: EventSchema,
    status: 200,
  })
  async publish(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof EventParamsSchema>,
  ): Promise<Event> {
    const { clubId } = resourceOf(authz, "event");
    return toEvent(
      await this.events.publishEvent(tenantContext(authz, clubId), params.eventId),
      true,
    );
  }

  @Endpoint({
    method: "POST",
    path: "events/:eventId/cancel",
    summary: "Cancel the event and its activities (registrations are kept)",
    tags: ["events"],
    access: { permission: "event.manage", resource: "event" },
    request: { params: EventParamsSchema, body: CancelEventSchema },
    response: EventSchema,
    status: 200,
  })
  async cancel(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof EventParamsSchema>,
    @Body() body: z.infer<typeof CancelEventSchema>,
  ): Promise<Event> {
    const { clubId } = resourceOf(authz, "event");
    return toEvent(
      await this.events.cancelEvent(
        tenantContext(authz, clubId),
        params.eventId,
        body.reason ?? null,
      ),
      true,
    );
  }

  @Endpoint({
    method: "DELETE",
    path: "events/:eventId",
    summary: "Delete a draft",
    tags: ["events"],
    access: { permission: "event.manage", resource: "event" },
    request: { params: EventParamsSchema },
    response: z.null(),
    status: 204,
  })
  async remove(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof EventParamsSchema>,
  ): Promise<null> {
    const { clubId } = resourceOf(authz, "event");
    await this.events.deleteEvent(tenantContext(authz, clubId), params.eventId);
    return null;
  }

  @Endpoint({
    method: "PUT",
    path: "events/:eventId/activities",
    summary: "Link exactly these activities of the audience groups (called up to the confirmed)",
    tags: ["events"],
    access: { permission: "event.manage", resource: "event" },
    request: { params: EventParamsSchema, body: SetEventActivitiesSchema },
    response: EventSchema,
  })
  async setActivities(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof EventParamsSchema>,
    @Body() body: z.infer<typeof SetEventActivitiesSchema>,
  ): Promise<Event> {
    const { clubId } = resourceOf(authz, "event");
    return toEvent(
      await this.events.setActivities(tenantContext(authz, clubId), params.eventId, body),
      true,
    );
  }

  // --- Sign-up --------------------------------------------------------------------------

  @Endpoint({
    method: "PUT",
    path: "events/:eventId/registrations/:personId",
    summary: "Sign up (or change the answers) for myself or a ward with sign_up",
    tags: ["events"],
    access: { permission: "event.register", resource: "event" },
    request: { params: RegistrationParamsSchema, body: RegisterSchema },
    response: EventDetailSchema,
    rateLimit: REGISTRATION_LIMIT,
  })
  async register(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof RegistrationParamsSchema>,
    @Body() body: RegisterInput,
  ): Promise<EventDetail> {
    const event = this.signUpFor(authz, params.personId);
    if (!inAudience(authz.actor, params.personId, event)) throw new DomainError("not_in_audience");
    await this.events.register(
      tenantContext(authz, event.clubId),
      params.eventId,
      params.personId,
      body,
    );
    return this.detail(authz, params.eventId);
  }

  @Endpoint({
    method: "DELETE",
    path: "events/:eventId/registrations/:personId",
    summary: "Cancel a registration (a place until the cancellation deadline)",
    tags: ["events"],
    access: { permission: "event.register", resource: "event" },
    request: { params: RegistrationParamsSchema },
    response: EventDetailSchema,
    rateLimit: REGISTRATION_LIMIT,
  })
  async cancelRegistration(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof RegistrationParamsSchema>,
  ): Promise<EventDetail> {
    const event = this.signUpFor(authz, params.personId);
    await this.events.cancelRegistration(
      tenantContext(authz, event.clubId),
      params.eventId,
      params.personId,
    );
    return this.detail(authz, params.eventId);
  }

  @Endpoint({
    method: "POST",
    path: "events/:eventId/registrations/:personId/accept",
    summary: "Accept an offered place",
    tags: ["events"],
    access: { permission: "event.register", resource: "event" },
    request: { params: RegistrationParamsSchema },
    response: EventDetailSchema,
    status: 200,
    rateLimit: REGISTRATION_LIMIT,
  })
  async accept(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof RegistrationParamsSchema>,
  ): Promise<EventDetail> {
    const event = this.signUpFor(authz, params.personId);
    await this.events.acceptOffer(
      tenantContext(authz, event.clubId),
      params.eventId,
      params.personId,
    );
    return this.detail(authz, params.eventId);
  }

  @Endpoint({
    method: "POST",
    path: "events/:eventId/registrations/:personId/decline",
    summary: "Decline an offered place (it goes to the next one)",
    tags: ["events"],
    access: { permission: "event.register", resource: "event" },
    request: { params: RegistrationParamsSchema },
    response: EventDetailSchema,
    status: 200,
    rateLimit: REGISTRATION_LIMIT,
  })
  async decline(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof RegistrationParamsSchema>,
  ): Promise<EventDetail> {
    const event = this.signUpFor(authz, params.personId);
    await this.events.declineOffer(
      tenantContext(authz, event.clubId),
      params.eventId,
      params.personId,
    );
    return this.detail(authz, params.eventId);
  }

  // --- Organisers --------------------------------------------------------------------

  @Endpoint({
    method: "GET",
    path: "events/:eventId/registrations",
    summary: "Everyone registered, with status, queue position and answers",
    tags: ["events"],
    access: { permission: "event.registrations.read", resource: "event" },
    request: { params: EventParamsSchema, query: RegistrationListQuerySchema },
    response: RegistrationListSchema,
    bulkRead: true,
  })
  async list(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof EventParamsSchema>,
    @Query() query: RegistrationListQuery,
  ): Promise<RegistrationList> {
    const event = resourceOf(authz, "event");
    const organiser = canManageEvent(authz.actor, event);
    const context = tenantContext(authz, event.clubId, { viewerPrivileged: true });
    const page = await this.events.registrationList(context, params.eventId, query, {
      sensitive: organiser,
    });
    const shown = await this.presented(authz, event.clubId, peopleOf(page.items));
    return {
      items: page.items.flatMap((item) => {
        const r = toRegistration(item, shown, { organiser });
        return r ? [r] : [];
      }),
      nextCursor: page.nextCursor,
      counts: page.counts,
    };
  }

  @Endpoint({
    method: "POST",
    path: "events/:eventId/registrations/:personId/confirm",
    summary: "Move a registration up out of order (with a reason)",
    tags: ["events"],
    access: { permission: "event.registrations.manage", resource: "event" },
    request: { params: RegistrationParamsSchema, body: RegistrationDecisionSchema },
    response: EventDetailSchema,
    status: 200,
  })
  async confirm(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof RegistrationParamsSchema>,
    @Body() body: z.infer<typeof RegistrationDecisionSchema>,
  ): Promise<EventDetail> {
    const { clubId } = resourceOf(authz, "event");
    await this.events.confirmRegistration(
      tenantContext(authz, clubId),
      params.eventId,
      params.personId,
      body.reason,
    );
    return this.detail(authz, params.eventId);
  }

  @Endpoint({
    method: "POST",
    path: "events/:eventId/registrations/:personId/remove",
    summary: "Remove a registration (with a reason)",
    tags: ["events"],
    access: { permission: "event.registrations.manage", resource: "event" },
    request: { params: RegistrationParamsSchema, body: RegistrationDecisionSchema },
    response: EventDetailSchema,
    status: 200,
  })
  async removeRegistration(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof RegistrationParamsSchema>,
    @Body() body: z.infer<typeof RegistrationDecisionSchema>,
  ): Promise<EventDetail> {
    const { clubId } = resourceOf(authz, "event");
    await this.events.removeRegistration(
      tenantContext(authz, clubId),
      params.eventId,
      params.personId,
      body.reason,
    );
    return this.detail(authz, params.eventId);
  }

  @Endpoint({
    method: "GET",
    path: "events/:eventId/registrations.csv",
    summary: "Export the registrations as CSV (sensitive answers: organisers with MFA)",
    tags: ["events"],
    access: { permission: "event.registrations.read", resource: "event" },
    request: { params: EventParamsSchema, query: RegistrationExportQuerySchema },
    response: z.string(),
    responseType: "text/csv",
    bulkRead: true,
    clubAccess: "export",
  })
  async export(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof EventParamsSchema>,
    @Query() query: z.infer<typeof RegistrationExportQuerySchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<string> {
    const event = resourceOf(authz, "event");
    const organiser = canManageEvent(authz.actor, event);
    if (query.sensitive && !organiser) throw new ProblemError("forbidden");
    if (query.sensitive && !authz.actor.mfa) {
      throw new ProblemError("forbidden", { detail: "mfa_required" });
    }
    const context = tenantContext(authz, event.clubId, { viewerPrivileged: true });
    const data = await this.events.exportRegistrations(context, params.eventId, {
      sensitive: query.sensitive,
    });
    const shown = await this.presented(authz, event.clubId, peopleOf(data.items));
    const questions = data.event.questions.filter((q) => query.sensitive || !q.sensitive);
    const header = [
      "name",
      "status",
      "position",
      "registered_at",
      "registered_by",
      ...questions.map((q) => q.label),
    ];
    const lines = [header];
    let hasProtected = false;
    for (const item of data.items) {
      const person = shown.get(item.registration.personId);
      if (!person) continue;
      hasProtected ||= person.protected;
      const by = shown.get(item.registration.registeredByPersonId);
      const answers: Answers = {
        ...item.registration.answers,
        ...(item.sensitiveAnswers ?? {}),
      } as Answers;
      lines.push([
        person.displayName,
        item.registration.status,
        item.position === null ? "" : String(item.position),
        iso(item.registration.queuedAt),
        by && by.id !== person.id ? by.displayName : "",
        ...questions.map((q) => csvValue(answers[q.id])),
      ]);
    }
    if (hasProtected) lines.unshift(["# contains protected persons: do not share"]);
    void reply.header("content-type", "text/csv; charset=utf-8");
    void reply.header(
      "content-disposition",
      `attachment; filename="event-${params.eventId}-registrations.csv"`,
    );
    void reply.header("cache-control", "no-store");
    return lines.map((cells) => cells.map(csvCell).join(",")).join("\r\n") + "\r\n";
  }

  // --- Me -------------------------------------------------------------------------------

  @Endpoint({
    method: "GET",
    path: "me/events",
    summary: "Events open to me and my wards, or that we are registered to, across clubs",
    tags: ["events"],
    access: { authenticated: true },
    request: { query: PageQuerySchema },
    response: MyEventsSchema,
  })
  async mine(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: z.infer<typeof PageQuerySchema>,
  ): Promise<MyEvents> {
    const actor = authz.actor;
    const family = familyOf(actor);
    const signUp = new Set(signUpPeople(actor));
    const result = await this.events.eventsForPeople(authz.context, {
      personIds: family,
      cursor: query.cursor ?? null,
      limit: query.limit,
    });
    const people = await this.presenter.present(
      authz,
      null,
      await this.people.summaries(authz.context, family),
    );
    const byEvent = new Map<string, RegistrationView[]>();
    for (const r of result.registrations) {
      byEvent.set(r.registration.eventId, [...(byEvent.get(r.registration.eventId) ?? []), r]);
    }
    const refs = await this.refsByClub(authz, result.items);
    return {
      items: result.items.flatMap((view) => {
        const resource = eventResource(view, refs);
        if (!canReadEvent(actor, resource)) return [];
        const registrations = byEvent.get(view.event.id) ?? [];
        return [
          {
            event: toEvent(view, canManageEvent(actor, resource)),
            people: people.flatMap((person) => {
              const reg = registrations.find((r) => r.registration.personId === person.id);
              const audience = inAudience(actor, person.id, resource);
              if (!reg && !audience) return [];
              return [
                {
                  person,
                  status: reg?.registration.status ?? null,
                  position: reg?.position ?? null,
                  canRegister: view.open && audience && signUp.has(person.id),
                },
              ];
            }),
          },
        ];
      }),
      nextCursor: result.nextCursor,
    };
  }

  // --- Helpers -------------------------------------------------------------------------

  /** The event, if the caller may sign up this person (else 404, as for a stranger). */
  private signUpFor(authz: RequestAuthorization, personId: string): EventResource {
    if (!signUpPeople(authz.actor).includes(personId)) throw new ProblemError("not-found");
    return resourceOf(authz, "event");
  }

  private async page(
    authz: RequestAuthorization,
    clubId: string,
    groupId: string | null,
    query: EventListQuery,
  ): Promise<EventPage> {
    const actor = authz.actor;
    const r = actor.relationships;
    const all = actor.hasClubRole(clubId, "club_manager", "registrar");
    const scope: EventScope = all
      ? { all: true }
      : {
          all: false,
          groupIds: [
            ...r.groups.filter((g) => g.clubId === clubId).map((g) => g.groupId),
            ...r.wardGroups.filter((g) => g.clubId === clubId).map((g) => g.groupId),
          ],
          ownedGroupIds: r.ownedGroups.filter((g) => g.clubId === clubId).map((g) => g.groupId),
          drafts: actor.hasClubRole(clubId, ...BOARD) || actor.managesAnyGroupActivities(clubId),
        };
    const context = tenantContext(authz, clubId);
    const page = await this.events.listEvents(context, { groupId, scope, query });
    const refs = await this.refsByClub(authz, page.items);
    return {
      items: page.items.flatMap((view) => {
        const resource = eventResource(view, refs);
        return canReadEvent(actor, resource)
          ? [toEvent(view, canManageEvent(actor, resource))]
          : [];
      }),
      nextCursor: page.nextCursor,
    };
  }

  /** Policy references of the events' audience groups (with ancestors), by group ID. */
  private async refsByClub(
    authz: RequestAuthorization,
    views: readonly EventView[],
  ): Promise<Map<string, GroupRef>> {
    const byClub = new Map<string, Set<string>>();
    for (const v of views) {
      const set = byClub.get(v.event.clubId) ?? new Set<string>();
      for (const g of v.groups) set.add(g.id);
      byClub.set(v.event.clubId, set);
    }
    const refs = new Map<string, GroupRef>();
    for (const [clubId, ids] of byClub) {
      if (ids.size === 0) continue;
      for (const ref of await this.authorization.groupRefs(authz, clubId, [...ids])) {
        refs.set(ref.groupId, ref);
      }
    }
    return refs;
  }

  private async detail(authz: RequestAuthorization, eventId: string): Promise<EventDetail> {
    const resource = resourceOf(authz, "event");
    const actor = authz.actor;
    const context = tenantContext(authz, resource.clubId);
    const view = await this.events.getEvent(context, eventId);
    const family = familyOf(actor);
    const signUp = new Set(signUpPeople(actor));
    const sealedFor = new Set(family.filter((id) => seesSealed(actor, id, resource)));
    const registrations = await this.events.familyRegistrations(
      context,
      eventId,
      family,
      sealedFor,
    );
    const namesAllowed =
      canManageEvent(actor, resource) ||
      (resource.audience === "groups"
        ? resource.groups.some((g) => canReadGroupMembers(actor, g))
        : actor.hasClubRole(resource.clubId, "club_manager", "registrar"));
    const confirmed = namesAllowed ? await this.events.confirmedPeople(context, eventId) : [];
    const shown = await this.presented(authz, resource.clubId, [
      ...family,
      ...confirmed,
      ...peopleOf(registrations),
    ]);
    const organiser = canManageEvent(actor, resource);
    return {
      ...toEvent(view, organiser),
      mine: family.flatMap((personId) => {
        const person = shown.get(personId);
        if (!person) return [];
        const reg = registrations.find((r) => r.registration.personId === personId) ?? null;
        const audience = inAudience(actor, personId, resource);
        if (!reg && !audience) return [];
        return [
          {
            person,
            registration: reg ? toRegistration(reg, shown, { organiser }) : null,
            canRegister: view.open && audience && signUp.has(personId),
          },
        ];
      }),
      participants: namesAllowed
        ? confirmed.flatMap((id) => {
            const person = shown.get(id);
            return person ? [person] : [];
          })
        : null,
    };
  }

  /** People the viewer may see, by ID (hidden ones are missing). */
  private async presented(
    authz: RequestAuthorization,
    clubId: string,
    personIds: readonly string[],
  ): Promise<Map<string, PersonSummary>> {
    const ids = [...new Set(personIds)];
    if (ids.length === 0) return new Map();
    const people = await this.people.summaries(tenantContext(authz, clubId), ids);
    return new Map((await this.presenter.present(authz, clubId, people)).map((p) => [p.id, p]));
  }
}

function eventResource(view: EventView, refs: ReadonlyMap<string, GroupRef>): EventResource {
  return {
    kind: "event",
    clubId: view.event.clubId,
    audience: view.event.audience,
    status: view.event.status,
    groups: view.groups.map(
      (g) => refs.get(g.id) ?? { clubId: view.event.clubId, groupId: g.id, ancestorIds: [] },
    ),
  };
}

function peopleOf(items: readonly RegistrationView[]): string[] {
  return items.flatMap((i) => [i.registration.personId, i.registration.registeredByPersonId]);
}

export function toEvent(view: EventView, canManage: boolean): Event {
  const e = view.event;
  return {
    id: e.id,
    clubId: e.clubId,
    timeZone: view.timeZone,
    title: e.title,
    description: e.description,
    audience: e.audience,
    groups: view.groups,
    status: e.status,
    cancelledReason: e.cancelledReason,
    startsAt: iso(e.startsAt),
    endsAt: iso(e.endsAt),
    location: view.location ? toLocationResponse(view.location) : null,
    locationText: e.locationText,
    priceText: e.priceText,
    registrationOpensAt: iso_(e.registrationOpensAt),
    registrationClosesAt: iso(e.registrationClosesAt),
    cancellationClosesAt: iso_(e.cancellationClosesAt),
    capacity: e.capacity,
    waitlistMode: e.waitlistMode,
    offerReplyHours: e.offerReplyHours,
    questions: e.questions,
    counts: view.counts,
    open: view.open,
    canManage,
    activities: view.activities.map((a) => ({
      id: a.id,
      kind: a.kind as Event["activities"][number]["kind"],
      kindLabel: a.kindLabel,
      title: a.title,
      status: a.status as Event["activities"][number]["status"],
      startsAt: iso(a.startsAt),
      endsAt: iso(a.endsAt),
    })),
  };
}

function toRegistration(
  item: RegistrationView,
  shown: ReadonlyMap<string, PersonSummary>,
  options: { organiser: boolean },
): Registration | null {
  const r = item.registration;
  const person = shown.get(r.personId);
  if (!person) return null;
  return {
    person,
    status: r.status,
    position: item.position,
    queuedAt: iso(r.queuedAt),
    offerExpiresAt: iso_(r.offerExpiresAt),
    answers: r.answers as Answers,
    ...(item.sensitiveAnswers ? { sensitiveAnswers: item.sensitiveAnswers } : {}),
    registeredBy: shown.get(r.registeredByPersonId) ?? null,
    ...(options.organiser ? { decisionReason: r.decisionReason } : {}),
    updatedAt: iso(r.updatedAt),
  };
}

export type { RegistrationResult };

function csvValue(value: Answers[string] | undefined): string {
  if (value === undefined) return "";
  if (Array.isArray(value)) return value.join("; ");
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

/** A CSV cell: quoted when needed, and never read as a formula by spreadsheets. */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
