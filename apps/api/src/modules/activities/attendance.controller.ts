// SPDX-License-Identifier: AGPL-3.0-only
// Responses and attendance (P1.5, ADR 0035). Whom the caller may answer for
// (themselves, and wards with the sign_up right) and whether they lead the
// activity, correct locked attendance or may see who is coming are decided
// here from the actor and the activity's groups; the service checks the
// roster, the deadline and the lock. People go through the PersonPresenter:
// protected members are counted, never named, for viewers who may not see
// them.

import {
  ActivityParamsSchema,
  type ActivityResponse,
  type Attendance,
  type AttendanceMark,
  AttendanceSchema,
  type GroupAttendance,
  type GroupAttendanceQuery,
  GroupAttendanceQuerySchema,
  GroupAttendanceSchema,
  GroupParamsSchema,
  type Invitees,
  InviteesSchema,
  type MyResponse,
  type PersonSummary,
  type RecordAttendanceInput,
  type RecordAttendanceResult,
  RecordAttendanceResultSchema,
  RecordAttendanceSchema,
  type ResponseList,
  type ResponseListQuery,
  ResponseListQuerySchema,
  ResponseListSchema,
  ResponseParamsSchema,
  type ResponseSummary,
  ResponseSummarySchema,
  type SetInviteesInput,
  SetInviteesSchema,
  type SetResponseInput,
  SetResponseSchema,
  z,
} from "@clubadmin/shared";
import { Body, Controller, Param, Query } from "@nestjs/common";

import { Endpoint } from "../../platform/http/endpoint.ts";
import { ProblemError } from "../../platform/http/problem-error.ts";
import {
  canLeadGroupActivities,
  canReadGroupMembers,
  CurrentAuthorization,
  type GroupRef,
  PersonPresenter,
  type RequestAuthorization,
  resourceOf,
  tenantContext,
} from "../authorization/index.ts";
type Actor = RequestAuthorization["actor"];
import { PeopleService } from "../people/index.ts";
import {
  AttendanceService,
  type AttendanceView,
  type InviteesView,
  type ResponseRow,
} from "./attendance.service.ts";

const iso = (date: Date) => date.toISOString();

/**
 * Whom the caller may answer for: the actor (the ward when acting on their
 * behalf), and otherwise the wards whose guardian holds sign_up (full
 * guardians hold every right).
 */
export function respondablePeople(authz: RequestAuthorization): string[] {
  const actor = authz.actor;
  if (actor.onBehalfOf) return [actor.personId];
  return [
    actor.personId,
    ...actor.relationships.wards
      .filter((w) => w.rights.includes("sign_up") || actor.isFullGuardianOf(w.personId))
      .map((w) => w.personId),
  ].filter((id, i, all) => all.indexOf(id) === i);
}

const leads = (actor: Actor, groups: readonly GroupRef[]) =>
  groups.some((g) => canLeadGroupActivities(actor, g));

@Controller()
export class AttendanceController {
  private readonly attendance: AttendanceService;
  private readonly people: PeopleService;
  private readonly presenter: PersonPresenter;

  constructor(attendance: AttendanceService, people: PeopleService, presenter: PersonPresenter) {
    this.attendance = attendance;
    this.people = people;
    this.presenter = presenter;
  }

  // --- Responses ---------------------------------------------------------------------

  @Endpoint({
    method: "PUT",
    path: "activities/:activityId/responses/:personId",
    summary: "Answer attending or not attending, for myself or a ward (until the deadline)",
    tags: ["activities"],
    access: { permission: "activity.respond", resource: "activity" },
    request: { params: ResponseParamsSchema, body: SetResponseSchema },
    response: ResponseSummarySchema,
  })
  async respond(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof ResponseParamsSchema>,
    @Body() body: SetResponseInput,
  ): Promise<ResponseSummary> {
    const { clubId } = this.answerFor(authz, params.personId);
    await this.attendance.respond(
      tenantContext(authz, clubId),
      params.activityId,
      params.personId,
      body,
    );
    return this.summaryOf(authz, params.activityId);
  }

  @Endpoint({
    method: "DELETE",
    path: "activities/:activityId/responses/:personId",
    summary: "Withdraw an answer (until the deadline)",
    tags: ["activities"],
    access: { permission: "activity.respond", resource: "activity" },
    request: { params: ResponseParamsSchema },
    response: ResponseSummarySchema,
  })
  async withdraw(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof ResponseParamsSchema>,
  ): Promise<ResponseSummary> {
    const { clubId } = this.answerFor(authz, params.personId);
    await this.attendance.withdraw(
      tenantContext(authz, clubId),
      params.activityId,
      params.personId,
    );
    return this.summaryOf(authz, params.activityId);
  }

  @Endpoint({
    method: "GET",
    path: "activities/:activityId/responses/summary",
    summary: "How many are coming; my family's answers; who is coming where I may see the group",
    tags: ["activities"],
    access: { permission: "activity.read", resource: "activity" },
    request: { params: ActivityParamsSchema },
    response: ResponseSummarySchema,
  })
  summary(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof ActivityParamsSchema>,
  ): Promise<ResponseSummary> {
    return this.summaryOf(authz, params.activityId);
  }

  @Endpoint({
    method: "GET",
    path: "activities/:activityId/responses",
    summary: "The leaders' list: everyone on the roster with their answer and note",
    tags: ["activities"],
    access: { permission: "activity.responses.read", resource: "activity" },
    request: { params: ActivityParamsSchema, query: ResponseListQuerySchema },
    response: ResponseListSchema,
  })
  async list(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof ActivityParamsSchema>,
    @Query() query: ResponseListQuery,
  ): Promise<ResponseList> {
    const { clubId } = resourceOf(authz, "activity");
    const context = tenantContext(authz, clubId, { viewerPrivileged: true });
    const page = await this.attendance.responseList(context, params.activityId, query);
    const shown = await this.presented(authz, clubId, [
      ...page.items.map((i) => i.personId),
      ...page.items.flatMap((i) => (i.response ? [i.response.respondedByPersonId] : [])),
    ]);
    return {
      items: page.items.flatMap((item) => {
        const person = shown.get(item.personId);
        return person ? [toResponse(person, item.response, shown, true)] : [];
      }),
      nextCursor: page.nextCursor,
      counts: page.counts,
    };
  }

  // --- Call-ups (#19) ------------------------------------------------------------------

  @Endpoint({
    method: "GET",
    path: "activities/:activityId/invitees",
    summary: "Who may be called up to the activity (its groups' members) and who is",
    tags: ["activities"],
    access: { permission: "activity.responses.read", resource: "activity" },
    request: { params: ActivityParamsSchema },
    response: InviteesSchema,
  })
  async invitees(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof ActivityParamsSchema>,
  ): Promise<Invitees> {
    const { clubId } = resourceOf(authz, "activity");
    const view = await this.attendance.invitees(
      tenantContext(authz, clubId, { viewerPrivileged: true }),
      params.activityId,
    );
    return this.toInvitees(authz, view);
  }

  @Endpoint({
    method: "PUT",
    path: "activities/:activityId/invitees",
    summary: "Call up some of the groups' members (only they answer and are counted), or all",
    tags: ["activities"],
    access: { permission: "activity.manage", resource: "activity" },
    request: { params: ActivityParamsSchema, body: SetInviteesSchema },
    response: InviteesSchema,
  })
  async setInvitees(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof ActivityParamsSchema>,
    @Body() body: SetInviteesInput,
  ): Promise<Invitees> {
    const { clubId } = resourceOf(authz, "activity");
    const view = await this.attendance.setInvitees(
      tenantContext(authz, clubId, { viewerPrivileged: true }),
      params.activityId,
      body,
    );
    return this.toInvitees(authz, view);
  }

  // --- Attendance ----------------------------------------------------------------------

  @Endpoint({
    method: "GET",
    path: "activities/:activityId/attendance",
    summary:
      "The roster and leaders with their marks, suggestions from the answers and grant hints",
    tags: ["activities"],
    access: { permission: "activity.attendance.manage", resource: "activity" },
    request: { params: ActivityParamsSchema },
    response: AttendanceSchema,
  })
  async getAttendance(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof ActivityParamsSchema>,
  ): Promise<Attendance> {
    const resource = resourceOf(authz, "activity");
    const view = await this.attendance.getAttendance(
      tenantContext(authz, resource.clubId, { viewerPrivileged: true }),
      params.activityId,
    );
    return this.toAttendance(authz, view);
  }

  @Endpoint({
    method: "PUT",
    path: "activities/:activityId/attendance",
    summary: "Record attendance marks (offline marks keep the device's time; the newer wins)",
    tags: ["activities"],
    access: { permission: "activity.attendance.manage", resource: "activity" },
    request: { params: ActivityParamsSchema, body: RecordAttendanceSchema },
    response: RecordAttendanceResultSchema,
  })
  async recordAttendance(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof ActivityParamsSchema>,
    @Body() body: RecordAttendanceInput,
  ): Promise<RecordAttendanceResult> {
    const resource = resourceOf(authz, "activity");
    const result = await this.attendance.recordAttendance(
      tenantContext(authz, resource.clubId, { viewerPrivileged: true }),
      params.activityId,
      body,
      this.rights(authz),
    );
    return { attendance: await this.toAttendance(authz, result.attendance), stale: result.stale };
  }

  @Endpoint({
    method: "GET",
    path: "groups/:groupId/attendance",
    summary: "A group's attendance over a period: sessions held and each member's marks",
    tags: ["activities"],
    access: { permission: "group.attendance.read", resource: "group" },
    request: { params: GroupParamsSchema, query: GroupAttendanceQuerySchema },
    response: GroupAttendanceSchema,
  })
  async groupAttendance(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: GroupAttendanceQuery,
  ): Promise<GroupAttendance> {
    const group = resourceOf(authz, "group");
    const view = await this.attendance.groupAttendance(
      tenantContext(authz, group.clubId, { viewerPrivileged: true }),
      group.groupId,
      query,
    );
    const shown = await this.presented(
      authz,
      group.clubId,
      view.members.map((m) => m.personId),
    );
    return {
      timeZone: view.timeZone,
      sessions: view.sessions.map((s) => ({
        activityId: s.session.activityId,
        title: s.session.title,
        kind: s.session.kind,
        startsAt: iso(s.session.startsAt),
        endsAt: iso(s.session.endsAt),
        recorded: s.recorded,
        present: s.present,
        leadersPresent: s.leadersPresent,
        hints: s.hints,
      })),
      members: view.members.flatMap((m) => {
        const person = shown.get(m.personId);
        if (!person) return [];
        const marked = m.present + m.absent + m.excused;
        return [
          {
            person,
            sessions: m.sessions,
            present: m.present,
            absent: m.absent,
            excused: m.excused,
            rate: marked === 0 ? null : Math.round((m.present / marked) * 1000) / 1000,
          },
        ];
      }),
      nextCursor: view.nextCursor,
    };
  }

  // --- Helpers -----------------------------------------------------------------------

  private async toInvitees(authz: RequestAuthorization, view: InviteesView): Promise<Invitees> {
    const shown = await this.presented(
      authz,
      view.activity.clubId,
      view.candidates.map((c) => c.personId),
    );
    return {
      activityId: view.activity.id,
      inviteesOnly: view.activity.inviteesOnly,
      candidates: view.candidates.flatMap((c) => {
        const person = shown.get(c.personId);
        return person ? [{ person, invited: c.invited }] : [];
      }),
      invitedCount: view.invitedCount,
    };
  }

  /** The activity's club, if the caller may answer for this person (else 404, as for a stranger). */
  private answerFor(authz: RequestAuthorization, personId: string): { clubId: string } {
    if (!respondablePeople(authz).includes(personId)) throw new ProblemError("not-found");
    return { clubId: resourceOf(authz, "activity").clubId };
  }

  private rights(authz: RequestAuthorization): { leads: boolean; corrects: boolean } {
    const resource = resourceOf(authz, "activity");
    const actor = authz.actor;
    return {
      leads: actor.isClubManager(resource.clubId) || leads(actor, resource.groups),
      corrects: actor.hasClubRole(resource.clubId, "club_manager", "registrar"),
    };
  }

  private async summaryOf(
    authz: RequestAuthorization,
    activityId: string,
  ): Promise<ResponseSummary> {
    const resource = resourceOf(authz, "activity");
    const family = respondablePeople(authz);
    const view = await this.attendance.summary(
      tenantContext(authz, resource.clubId),
      activityId,
      family,
    );
    const namesAllowed = resource.groups.some((g) => canReadGroupMembers(authz.actor, g));
    const shown = await this.presented(authz, resource.clubId, [
      ...(namesAllowed ? view.attending : []),
      ...view.mine.flatMap((m) => [
        m.personId,
        ...(m.response ? [m.response.respondedByPersonId] : []),
      ]),
    ]);
    return {
      activityId,
      responseMode: view.activity.responseMode,
      respondBy: view.activity.respondBy ? iso(view.activity.respondBy) : null,
      open: view.state.open,
      deadlinePassed: view.state.deadlinePassed,
      counts: view.counts,
      attending: namesAllowed
        ? view.attending.flatMap((id) => {
            const person = shown.get(id);
            return person ? [person] : [];
          })
        : null,
      mine: view.mine.flatMap((m): MyResponse[] => {
        const person = shown.get(m.personId);
        if (!person) return [];
        return [{ ...toResponse(person, m.response, shown, true), canRespond: view.state.open }];
      }),
    };
  }

  private async toAttendance(
    authz: RequestAuthorization,
    view: AttendanceView,
  ): Promise<Attendance> {
    const rights = this.rights(authz);
    const entries = [...view.participants, ...view.leaders];
    const people = await this.people.summaries(
      tenantContext(authz, view.activity.clubId),
      entries.map((e) => e.personId),
    );
    const shown = new Map(
      (await this.presenter.present(authz, view.activity.clubId, people)).map((p) => [p.id, p]),
    );
    const mark = (e: AttendanceView["participants"][number]): AttendanceMark[] => {
      const person = shown.get(e.personId);
      if (!person) return [];
      return [
        {
          person,
          role: e.role,
          status: e.mark?.status ?? null,
          suggested: e.suggested,
          guest: e.guest,
          recordedAt: e.mark ? iso(e.mark.recordedAt) : null,
          correctedReason: e.mark?.correctedReason ?? null,
        },
      ];
    };
    const participants = view.participants.flatMap(mark);
    const leadersList = view.leaders.flatMap(mark);
    return {
      activityId: view.activity.id,
      locked: view.locked,
      open: view.open,
      canRecord: view.open && !view.locked && rights.leads,
      canCorrect: view.open && view.locked && rights.corrects,
      participants,
      leaders: leadersList,
      hasProtected: [...participants, ...leadersList].some((m) => m.person.protected),
      hints: view.hints,
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

function toResponse(
  person: PersonSummary,
  response: ResponseRow | null,
  shown: ReadonlyMap<string, PersonSummary>,
  withNote: boolean,
): ActivityResponse {
  return {
    person,
    status: response?.status ?? null,
    ...(withNote ? { note: response?.note ?? null } : {}),
    respondedBy: response ? (shown.get(response.respondedByPersonId) ?? null) : null,
    respondedAt: response ? iso(response.respondedAt) : null,
  };
}
