// SPDX-License-Identifier: AGPL-3.0-only
// Volunteer duties (P2.6 part A, ADR 0050): the catalogue of duty types and
// the club's duty settings, a group's and the club's shifts, an activity's
// shifts, sign-up and assignment, and quotas. People in responses go
// through the PersonPresenter (ADR 0022); until the visibility setting
// (part B) others' names on a shift are shown to its planners only.

import {
  type AssignDutyInput,
  AssignDutySchema,
  ClubDutyShiftIdParamsSchema,
  ClubParamsSchema,
  type CreateDutyShiftInput,
  CreateDutyShiftSchema,
  type CreateDutyTypeInput,
  CreateDutyTypeSchema,
  DutyAssignmentCreatedSchema,
  DutyAssignmentParamsSchema,
  type DutyQuota,
  DutyQuotaQuerySchema,
  DutyQuotaSchema,
  type DutySettings,
  DutySettingsSchema,
  type DutyShift,
  DutyShiftCreatedSchema,
  type DutyShiftList,
  DutyShiftListSchema,
  type DutyShiftRangeQuery,
  DutyShiftRangeQuerySchema,
  type DutySignUpInput,
  DutySignUpSchema,
  type DutyType,
  type DutyTypeList,
  DutyTypeListSchema,
  DutyTypeParamsSchema,
  type DutyTypeQuery,
  DutyTypeQuerySchema,
  DutyTypeSchema,
  GroupDutyAssignmentParamsSchema,
  GroupDutyShiftIdParamsSchema,
  GroupDutyShiftParamsSchema,
  type PersonSummary,
  type PutDutyQuotaInput,
  PutDutyQuotaSchema,
  type PutDutySettingsInput,
  PutDutySettingsSchema,
  type UpdateDutyShiftInput,
  UpdateDutyShiftSchema,
  type UpdateDutyTypeInput,
  UpdateDutyTypeSchema,
  z,
} from "@clubadmin/shared";
import { Body, Controller, Param, Query } from "@nestjs/common";

import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  CurrentAuthorization,
  PersonPresenter,
  type RequestAuthorization,
  tenantContext,
} from "../authorization/index.ts";
import { PeopleService } from "../people/index.ts";
import {
  type AssignmentRow,
  DutiesService,
  type DutyTypeRow,
  type Family,
  type ShiftRow,
  type ShiftScope,
} from "./duties.service.ts";

const TAGS = ["duties"];
const ActivityParamsSchema = z.object({ activityId: z.uuid() });

const toType = (t: DutyTypeRow): DutyType => ({
  id: t.id,
  name: t.name,
  instruction: t.instruction,
  instructionDocumentIds: t.instructionDocumentIds,
  minAge: t.minAge,
  childContact: t.childContact,
  requiredQualifications: t.requiredQualifications,
  archived: t.archived,
});

/** The day range as instants (from its first midnight UTC to the one after its last day). */
const rangeOf = (q: DutyShiftRangeQuery) => ({
  from: new Date(`${q.from}T00:00:00Z`),
  to: new Date(Date.parse(`${q.to}T00:00:00Z`) + 86_400_000),
});

@Controller()
export class DutiesController {
  private readonly duties: DutiesService;
  private readonly people: PeopleService;
  private readonly presenter: PersonPresenter;

  constructor(duties: DutiesService, people: PeopleService, presenter: PersonPresenter) {
    this.duties = duties;
    this.people = people;
    this.presenter = presenter;
  }

  /** The caller and the children they may act for (never another's children when acting for one). */
  private family(authz: RequestAuthorization): Family {
    if (authz.actor.onBehalfOf) return { me: authz.actor.personId, wardIds: [] };
    return {
      me: authz.actor.personId,
      wardIds: authz.actor.relationships.wards
        .filter((w) => w.rights.includes("act_on_behalf"))
        .map((w) => w.personId),
    };
  }

  private async persons(
    authz: RequestAuthorization,
    clubId: string,
    ids: readonly (string | null)[],
  ): Promise<Map<string, PersonSummary>> {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (unique.length === 0) return new Map();
    const rows = await this.people.summaries(tenantContext(authz, clubId), unique);
    return new Map((await this.presenter.present(authz, clubId, rows)).map((p) => [p.id, p]));
  }

  /** Whether the caller plans the shift's shifts (its group's planners or the club's). */
  private plans(authz: RequestAuthorization, shift: ShiftRow): boolean {
    if (authz.actor.onBehalfOf) return false;
    if (authz.actor.holds("club.duties.manage", shift.clubId)) return true;
    return (
      shift.groupId !== null &&
      authz.actor.holds("group.duties.manage", { clubId: shift.clubId, groupId: shift.groupId })
    );
  }

  private async shiftList(
    authz: RequestAuthorization,
    clubId: string,
    result: { shifts: ShiftRow[]; assignments: AssignmentRow[]; timeZone: string },
    allNames: boolean,
  ): Promise<DutyShiftList> {
    const family = this.family(authz);
    const own = new Set([family.me, ...family.wardIds]);
    const isMine = (a: AssignmentRow) =>
      own.has(a.personId) || (a.countsForPersonId !== null && own.has(a.countsForPersonId));
    const named = (shift: ShiftRow) => allNames || this.plans(authz, shift);
    const shown = result.assignments.filter((a) => {
      const shift = result.shifts.find((s) => s.id === a.shiftId)!;
      return named(shift) || isMine(a);
    });
    const persons = await this.persons(
      authz,
      clubId,
      shown.flatMap((a) => [a.personId, a.countsForPersonId]),
    );
    const items: DutyShift[] = result.shifts.map((s) => {
      const of = result.assignments.filter((a) => a.shiftId === s.id);
      return {
        id: s.id,
        clubId: s.clubId,
        groupId: s.groupId,
        groupName: s.groupName,
        dutyType: {
          id: s.dutyTypeId,
          name: s.typeName,
          minAge: s.minAge,
          childContact: s.childContact,
        },
        title: s.title,
        note: s.note,
        startsAt: s.startsAt.toISOString(),
        endsAt: s.endsAt.toISOString(),
        timeZone: result.timeZone,
        locationId: s.locationId,
        locationName: s.locationName,
        activityId: s.activityId,
        eventId: s.eventId,
        needed: s.needed,
        filled: of.length,
        assignments: of
          .filter((a) => named(s) || isMine(a))
          .map((a) => ({
            id: a.id,
            person: persons.get(a.personId) ?? null,
            countsFor: (a.countsForPersonId && persons.get(a.countsForPersonId)) || null,
            source: a.source,
            status: a.status,
            mine: isMine(a),
          })),
      };
    });
    // Unstaffed first, then by time (the order the repository read them in).
    items.sort((a, b) => Number(a.filled >= a.needed) - Number(b.filled >= b.needed));
    const groupIds = new Set(result.shifts.map((s) => s.groupId).filter(Boolean));
    const familyGroups = [
      ...authz.actor.relationships.groups.filter((g) => g.function === "member"),
      ...authz.actor.relationships.wardGroups.filter(
        (g) => g.function === "member" && family.wardIds.includes(g.personId),
      ),
    ];
    return {
      items,
      canSignUp: familyGroups.some((g) => groupIds.has(g.groupId)),
    };
  }

  // --- The catalogue and the club's settings -------------------------------------

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/duty-types",
    summary: "The club's duty types (for those who plan shifts)",
    tags: TAGS,
    access: { permission: "club.duties.read", resource: "club" },
    request: { params: ClubParamsSchema, query: DutyTypeQuerySchema },
    response: DutyTypeListSchema,
  })
  async types(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string },
    @Query() query: DutyTypeQuery,
  ): Promise<DutyTypeList> {
    const result = await this.duties.listTypes(tenantContext(authz, params.clubId), query.archived);
    return {
      items: result.types.map(toType),
      aloneWithChildrenAllowed: result.aloneWithChildrenAllowed,
      canManage:
        !authz.actor.onBehalfOf && authz.actor.holds("club.duty_types.manage", params.clubId),
    };
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/duty-types",
    summary: "Add a duty type (alone with children only where the country and club allow it)",
    tags: TAGS,
    access: { permission: "club.duty_types.manage", resource: "club" },
    request: { params: ClubParamsSchema, body: CreateDutyTypeSchema },
    response: DutyShiftCreatedSchema,
    status: 201,
  })
  createType(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string },
    @Body() body: CreateDutyTypeInput,
  ): Promise<{ id: string }> {
    return this.duties.createType(tenantContext(authz, params.clubId), body);
  }

  @Endpoint({
    method: "PATCH",
    path: "clubs/:clubId/duty-types/:typeId",
    summary: "Change or archive a duty type",
    tags: TAGS,
    access: { permission: "club.duty_types.manage", resource: "club" },
    request: { params: DutyTypeParamsSchema, body: UpdateDutyTypeSchema },
    response: DutyTypeSchema,
  })
  async updateType(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; typeId: string },
    @Body() body: UpdateDutyTypeInput,
  ): Promise<DutyType> {
    return toType(
      await this.duties.updateType(tenantContext(authz, params.clubId), params.typeId, body),
    );
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/duty-settings",
    summary:
      "The club's duty settings and whether its country forbids an adult alone with children",
    tags: TAGS,
    access: { permission: "club.duties.read", resource: "club" },
    request: { params: ClubParamsSchema },
    response: DutySettingsSchema,
  })
  settings(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string },
  ): Promise<DutySettings> {
    return this.duties.getSettings(tenantContext(authz, params.clubId));
  }

  @Endpoint({
    method: "PUT",
    path: "clubs/:clubId/duty-settings",
    summary: "Set the club's duty settings (never weaker than the country)",
    tags: TAGS,
    access: { permission: "club.duty_types.manage", resource: "club" },
    request: { params: ClubParamsSchema, body: PutDutySettingsSchema },
    response: z.null(),
    status: 204,
  })
  async putSettings(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string },
    @Body() body: PutDutySettingsInput,
  ): Promise<null> {
    await this.duties.putSettings(tenantContext(authz, params.clubId), body);
    return null;
  }

  // --- A group's shifts -----------------------------------------------------------

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/groups/:groupId/duty-shifts",
    summary: "The group's shifts in a period with who is on them (its planners)",
    tags: TAGS,
    access: { permission: "group.duties.manage", resource: "group" },
    request: { params: GroupDutyShiftParamsSchema, query: DutyShiftRangeQuerySchema },
    response: DutyShiftListSchema,
  })
  async groupShifts(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; groupId: string },
    @Query() query: DutyShiftRangeQuery,
  ): Promise<DutyShiftList> {
    const result = await this.duties.listShifts(
      tenantContext(authz, params.clubId),
      { groupId: params.groupId },
      rangeOf(query),
    );
    return this.shiftList(authz, params.clubId, result, true);
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/groups/:groupId/duty-shifts",
    summary: "Add a shift in the group (optionally of one of its activities or events)",
    tags: TAGS,
    access: { permission: "group.duties.manage", resource: "group" },
    request: { params: GroupDutyShiftParamsSchema, body: CreateDutyShiftSchema },
    response: DutyShiftCreatedSchema,
    status: 201,
  })
  createGroupShift(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; groupId: string },
    @Body() body: CreateDutyShiftInput,
  ): Promise<{ id: string }> {
    return this.duties.createShift(
      tenantContext(authz, params.clubId),
      { groupId: params.groupId },
      body,
    );
  }

  @Endpoint({
    method: "PATCH",
    path: "clubs/:clubId/groups/:groupId/duty-shifts/:shiftId",
    summary: "Change a shift of the group",
    tags: TAGS,
    access: { permission: "group.duties.manage", resource: "group" },
    request: { params: GroupDutyShiftIdParamsSchema, body: UpdateDutyShiftSchema },
    response: z.null(),
    status: 204,
  })
  async updateGroupShift(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; groupId: string; shiftId: string },
    @Body() body: UpdateDutyShiftInput,
  ): Promise<null> {
    await this.duties.updateShift(
      tenantContext(authz, params.clubId),
      { groupId: params.groupId },
      params.shiftId,
      body,
    );
    return null;
  }

  @Endpoint({
    method: "DELETE",
    path: "clubs/:clubId/groups/:groupId/duty-shifts/:shiftId",
    summary: "Delete a shift of the group (with its assignments)",
    tags: TAGS,
    access: { permission: "group.duties.manage", resource: "group" },
    request: { params: GroupDutyShiftIdParamsSchema },
    response: z.null(),
    status: 204,
  })
  async deleteGroupShift(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; groupId: string; shiftId: string },
  ): Promise<null> {
    await this.duties.deleteShift(
      tenantContext(authz, params.clubId),
      { groupId: params.groupId },
      params.shiftId,
    );
    return null;
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/groups/:groupId/duty-shifts/:shiftId/assignments",
    summary: "Put someone on a shift of the group (counting for one of the family's players)",
    tags: TAGS,
    access: { permission: "group.duties.manage", resource: "group" },
    request: { params: GroupDutyShiftIdParamsSchema, body: AssignDutySchema },
    response: DutyAssignmentCreatedSchema,
    status: 201,
  })
  assignInGroup(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; groupId: string; shiftId: string },
    @Body() body: AssignDutyInput,
  ): Promise<{ id: string; countsForPersonId: string | null }> {
    return this.duties.assign(
      tenantContext(authz, params.clubId),
      { groupId: params.groupId },
      params.shiftId,
      body,
    );
  }

  @Endpoint({
    method: "DELETE",
    path: "clubs/:clubId/groups/:groupId/duty-shifts/:shiftId/assignments/:assignmentId",
    summary: "Take someone off a shift of the group",
    tags: TAGS,
    access: { permission: "group.duties.manage", resource: "group" },
    request: { params: GroupDutyAssignmentParamsSchema },
    response: z.null(),
    status: 204,
  })
  async unassignInGroup(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; groupId: string; shiftId: string; assignmentId: string },
  ): Promise<null> {
    await this.duties.unassign(
      tenantContext(authz, params.clubId),
      { groupId: params.groupId },
      params.shiftId,
      params.assignmentId,
    );
    return null;
  }

  // --- The club's own shifts (and every group's for the club's planners) ----------

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/duty-shifts",
    summary: "The club's own shifts (no group) in a period",
    tags: TAGS,
    access: { permission: "club.duties.manage", resource: "club" },
    request: { params: ClubParamsSchema, query: DutyShiftRangeQuerySchema },
    response: DutyShiftListSchema,
  })
  async clubShifts(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string },
    @Query() query: DutyShiftRangeQuery,
  ): Promise<DutyShiftList> {
    const result = await this.duties.listShifts(
      tenantContext(authz, params.clubId),
      { club: true },
      rangeOf(query),
    );
    return this.shiftList(authz, params.clubId, result, true);
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/duty-shifts",
    summary: "Add a shift of the club (no group)",
    tags: TAGS,
    access: { permission: "club.duties.manage", resource: "club" },
    request: { params: ClubParamsSchema, body: CreateDutyShiftSchema },
    response: DutyShiftCreatedSchema,
    status: 201,
  })
  createClubShift(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string },
    @Body() body: CreateDutyShiftInput,
  ): Promise<{ id: string }> {
    return this.duties.createShift(tenantContext(authz, params.clubId), { club: true }, body);
  }

  @Endpoint({
    method: "PATCH",
    path: "clubs/:clubId/duty-shifts/:shiftId",
    summary: "Change any shift of the club",
    tags: TAGS,
    access: { permission: "club.duties.manage", resource: "club" },
    request: { params: ClubDutyShiftIdParamsSchema, body: UpdateDutyShiftSchema },
    response: z.null(),
    status: 204,
  })
  async updateClubShift(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; shiftId: string },
    @Body() body: UpdateDutyShiftInput,
  ): Promise<null> {
    await this.duties.updateShift(
      tenantContext(authz, params.clubId),
      { club: true },
      params.shiftId,
      body,
    );
    return null;
  }

  @Endpoint({
    method: "DELETE",
    path: "clubs/:clubId/duty-shifts/:shiftId",
    summary: "Delete any shift of the club (with its assignments)",
    tags: TAGS,
    access: { permission: "club.duties.manage", resource: "club" },
    request: { params: ClubDutyShiftIdParamsSchema },
    response: z.null(),
    status: 204,
  })
  async deleteClubShift(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; shiftId: string },
  ): Promise<null> {
    await this.duties.deleteShift(
      tenantContext(authz, params.clubId),
      { club: true },
      params.shiftId,
    );
    return null;
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/duty-shifts/:shiftId/assignments",
    summary: "Put someone on any shift of the club",
    tags: TAGS,
    access: { permission: "club.duties.manage", resource: "club" },
    request: { params: ClubDutyShiftIdParamsSchema, body: AssignDutySchema },
    response: DutyAssignmentCreatedSchema,
    status: 201,
  })
  assignInClub(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; shiftId: string },
    @Body() body: AssignDutyInput,
  ): Promise<{ id: string; countsForPersonId: string | null }> {
    return this.duties.assign(
      tenantContext(authz, params.clubId),
      { club: true },
      params.shiftId,
      body,
    );
  }

  @Endpoint({
    method: "DELETE",
    path: "clubs/:clubId/duty-shifts/:shiftId/assignments/:assignmentId",
    summary: "Take someone off any shift of the club",
    tags: TAGS,
    access: { permission: "club.duties.manage", resource: "club" },
    request: { params: DutyAssignmentParamsSchema },
    response: z.null(),
    status: 204,
  })
  async unassignInClub(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; shiftId: string; assignmentId: string },
  ): Promise<null> {
    await this.duties.unassign(
      tenantContext(authz, params.clubId),
      { club: true },
      params.shiftId,
      params.assignmentId,
    );
    return null;
  }

  // --- Sign-up (members and guardians) ---------------------------------------------

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/duty-shifts/:shiftId/signups",
    summary: "Sign up for a shift (oneself or a child), counting for one of the family's players",
    tags: TAGS,
    access: { authenticated: true },
    request: { params: ClubDutyShiftIdParamsSchema, body: DutySignUpSchema },
    response: DutyAssignmentCreatedSchema,
    status: 201,
  })
  signUp(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; shiftId: string },
    @Body() body: DutySignUpInput,
  ): Promise<{ id: string; countsForPersonId: string | null }> {
    return this.duties.signUp(
      tenantContext(authz, params.clubId),
      this.family(authz),
      params.shiftId,
      body,
    );
  }

  @Endpoint({
    method: "DELETE",
    path: "clubs/:clubId/duty-shifts/:shiftId/signups/:assignmentId",
    summary: "Cancel one's own or one's child's sign-up before the shift",
    tags: TAGS,
    access: { authenticated: true },
    request: { params: DutyAssignmentParamsSchema },
    response: z.null(),
    status: 204,
  })
  async cancelSignUp(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; shiftId: string; assignmentId: string },
  ): Promise<null> {
    await this.duties.cancelSignUp(
      tenantContext(authz, params.clubId),
      this.family(authz),
      params.shiftId,
      params.assignmentId,
    );
    return null;
  }

  // --- An activity's shifts --------------------------------------------------------

  @Endpoint({
    method: "GET",
    path: "activities/:activityId/duty-shifts",
    summary: "An activity's shifts: names for their planners, one's own family's for others",
    tags: TAGS,
    access: { permission: "activity.read", resource: "activity" },
    request: { params: ActivityParamsSchema },
    response: DutyShiftListSchema,
  })
  async activityShifts(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { activityId: string },
  ): Promise<DutyShiftList> {
    const resource = authz.resource as { clubId: string } | null;
    const clubId = resource?.clubId;
    if (!clubId) return { items: [], canSignUp: false };
    const result = await this.duties.listShifts(
      tenantContext(authz, clubId),
      { activityId: params.activityId },
      null,
    );
    return this.shiftList(authz, clubId, result, false);
  }

  // --- Quotas ----------------------------------------------------------------------

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/groups/:groupId/duty-quotas",
    summary: "The group's quota in a season and every player's shifts (done and planned)",
    tags: TAGS,
    access: { permission: "group.duties.manage", resource: "group" },
    request: { params: GroupDutyShiftParamsSchema, query: DutyQuotaQuerySchema },
    response: DutyQuotaSchema,
  })
  async quota(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; groupId: string },
    @Query() query: { seasonId: string },
  ): Promise<DutyQuota> {
    const result = await this.duties.getQuota(
      tenantContext(authz, params.clubId),
      params.groupId,
      query.seasonId,
    );
    const persons = await this.persons(
      authz,
      params.clubId,
      result.players.map((p) => p.personId),
    );
    return {
      groupId: params.groupId,
      seasonId: query.seasonId,
      shiftsPerPlayer: result.shiftsPerPlayer,
      players: result.players
        .map((p) => ({ person: persons.get(p.personId) ?? null, done: p.done, planned: p.planned }))
        .sort((a, b) => (a.person?.displayName ?? "￿").localeCompare(b.person?.displayName ?? "￿")),
    };
  }

  @Endpoint({
    method: "PUT",
    path: "clubs/:clubId/groups/:groupId/duty-quotas",
    summary: "Set the group's shifts per player in a season (none: no quota)",
    tags: TAGS,
    access: { permission: "group.duties.manage", resource: "group" },
    request: { params: GroupDutyShiftParamsSchema, body: PutDutyQuotaSchema },
    response: z.null(),
    status: 204,
  })
  async putQuota(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; groupId: string },
    @Body() body: PutDutyQuotaInput,
  ): Promise<null> {
    await this.duties.putQuota(tenantContext(authz, params.clubId), params.groupId, body);
    return null;
  }
}

export type { ShiftScope };
