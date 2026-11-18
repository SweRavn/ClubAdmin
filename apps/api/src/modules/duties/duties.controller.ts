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
  type CreateDutySwapInput,
  CreateDutySwapSchema,
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
  DutyStatsQuerySchema,
  type DutySwap,
  type DutyType,
  type DutyTypeList,
  DutyTypeListSchema,
  DutyTypeParamsSchema,
  type DutyTypeQuery,
  DutyTypeQuerySchema,
  DutyTypeSchema,
  type DutyVisibility,
  GroupDutyAssignmentParamsSchema,
  type GroupDutySettings,
  GroupDutySettingsSchema,
  GroupDutyShiftIdParamsSchema,
  GroupDutyShiftParamsSchema,
  type MyDuties,
  MyDutiesQuerySchema,
  MyDutiesSchema,
  type PersonSummary,
  type PutDutyQuotaInput,
  PutDutyQuotaSchema,
  type PutDutySettingsInput,
  PutDutySettingsSchema,
  type PutGroupDutySettingsInput,
  PutGroupDutySettingsSchema,
  type SetDutyStatusInput,
  SetDutyStatusSchema,
  type TakeDutySwapInput,
  TakeDutySwapSchema,
  type UpdateDutyShiftInput,
  UpdateDutyShiftSchema,
  type UpdateDutyTypeInput,
  UpdateDutyTypeSchema,
  z,
} from "@clubadmin/shared";
import { Body, Controller, Param, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";

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
  type SwapRow,
} from "./duties.service.ts";

const TAGS = ["duties"];
const GroupAssignmentStatusParamsSchema = z.object({
  clubId: z.uuid(),
  groupId: z.uuid(),
  shiftId: z.uuid(),
  assignmentId: z.uuid(),
});
const ClubAssignmentStatusParamsSchema = z.object({
  clubId: z.uuid(),
  shiftId: z.uuid(),
  assignmentId: z.uuid(),
});
const ClubSwapParamsSchema = z.object({ clubId: z.uuid(), swapId: z.uuid() });
const ClubAssignmentParamsSchema = z.object({ clubId: z.uuid(), assignmentId: z.uuid() });

/** A CSV cell: quoted when needed; text never read as a formula. */
function csvCell(value: string): string {
  const numeric = /^-?\d+(\.\d+)?$/.test(value);
  const safe = !numeric && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
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
    visibility?: { club: DutyVisibility; groups: Map<string, DutyVisibility> },
  ): Promise<DutyShiftList> {
    const family = this.family(authz);
    const own = new Set([family.me, ...family.wardIds]);
    const isMine = (a: AssignmentRow) =>
      own.has(a.personId) || (a.countsForPersonId !== null && own.has(a.countsForPersonId));
    // Names on a shift: its planners always; others unless the group's (or
    // the club's) visibility is `leaders`.
    const named = (shift: ShiftRow) =>
      allNames ||
      this.plans(authz, shift) ||
      (visibility !== undefined &&
        (shift.groupId ? visibility.groups.get(shift.groupId) : visibility.club) !== "leaders" &&
        (shift.groupId ? visibility.groups.get(shift.groupId) : visibility.club) !== undefined);
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
    const context = tenantContext(authz, clubId);
    const result = await this.duties.listShifts(context, { activityId: params.activityId }, null);
    const visibility = await this.duties.visibilityOf(
      context,
      result.shifts.map((x) => x.groupId),
    );
    return this.shiftList(authz, clubId, result, false, visibility);
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

  // --- Marking (the planners) ------------------------------------------------------

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/groups/:groupId/duty-shifts/:shiftId/assignments/:assignmentId/status",
    summary: "Mark a shift done or missed for someone (after it has started)",
    tags: TAGS,
    access: { permission: "group.duties.manage", resource: "group" },
    request: { params: GroupAssignmentStatusParamsSchema, body: SetDutyStatusSchema },
    response: z.null(),
    status: 204,
  })
  async markInGroup(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; groupId: string; shiftId: string; assignmentId: string },
    @Body() body: SetDutyStatusInput,
  ): Promise<null> {
    await this.duties.setStatus(
      tenantContext(authz, params.clubId),
      { groupId: params.groupId },
      params.shiftId,
      params.assignmentId,
      body,
    );
    return null;
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/duty-shifts/:shiftId/assignments/:assignmentId/status",
    summary: "Mark any shift of the club done or missed for someone",
    tags: TAGS,
    access: { permission: "club.duties.manage", resource: "club" },
    request: { params: ClubAssignmentStatusParamsSchema, body: SetDutyStatusSchema },
    response: z.null(),
    status: 204,
  })
  async markInClub(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; shiftId: string; assignmentId: string },
    @Body() body: SetDutyStatusInput,
  ): Promise<null> {
    await this.duties.setStatus(
      tenantContext(authz, params.clubId),
      { club: true },
      params.shiftId,
      params.assignmentId,
      body,
    );
    return null;
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/groups/:groupId/duty-shifts-to-mark",
    summary: "Att markera: the group's past shifts with someone still planned",
    tags: TAGS,
    access: { permission: "group.duties.manage", resource: "group" },
    request: { params: GroupDutyShiftParamsSchema },
    response: DutyShiftListSchema,
  })
  async groupToMark(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; groupId: string },
  ): Promise<DutyShiftList> {
    const result = await this.duties.toMark(tenantContext(authz, params.clubId), {
      groupId: params.groupId,
    });
    return this.shiftList(authz, params.clubId, result, true);
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/duty-shifts-to-mark",
    summary: "Att markera: the club's own past shifts with someone still planned",
    tags: TAGS,
    access: { permission: "club.duties.manage", resource: "club" },
    request: { params: ClubParamsSchema },
    response: DutyShiftListSchema,
  })
  async clubToMark(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string },
  ): Promise<DutyShiftList> {
    const result = await this.duties.toMark(tenantContext(authz, params.clubId), { club: true });
    return this.shiftList(authz, params.clubId, result, true);
  }

  // --- A group's visibility --------------------------------------------------------

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/groups/:groupId/duty-settings",
    summary: "The group's duty visibility and whether the club lets it choose",
    tags: TAGS,
    access: { permission: "group.duties.manage", resource: "group" },
    request: { params: GroupDutyShiftParamsSchema },
    response: GroupDutySettingsSchema,
  })
  groupSettings(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; groupId: string },
  ): Promise<GroupDutySettings> {
    return this.duties.getGroupSettings(tenantContext(authz, params.clubId), params.groupId);
  }

  @Endpoint({
    method: "PUT",
    path: "clubs/:clubId/groups/:groupId/duty-settings",
    summary: "Choose the group's duty visibility (when the club allows it; none: the club's)",
    tags: TAGS,
    access: { permission: "group.duties.manage", resource: "group" },
    request: { params: GroupDutyShiftParamsSchema, body: PutGroupDutySettingsSchema },
    response: z.null(),
    status: 204,
  })
  async putGroupSettings(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; groupId: string },
    @Body() body: PutGroupDutySettingsInput,
  ): Promise<null> {
    await this.duties.putGroupSettings(tenantContext(authz, params.clubId), params.groupId, body);
    return null;
  }

  // --- Swaps -----------------------------------------------------------------------

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/duty-assignments/:assignmentId/swaps",
    summary: "Offer one's shift, or ask to take over someone else's",
    tags: TAGS,
    access: { authenticated: true },
    request: { params: ClubAssignmentParamsSchema, body: CreateDutySwapSchema },
    response: DutyShiftCreatedSchema,
    status: 201,
  })
  createSwap(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; assignmentId: string },
    @Body() body: CreateDutySwapInput,
  ): Promise<{ id: string }> {
    return this.duties.createSwap(
      tenantContext(authz, params.clubId),
      this.family(authz),
      params.assignmentId,
      body,
    );
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/duty-swaps/:swapId/take",
    summary: "Take an offered shift (the confirmation)",
    tags: TAGS,
    access: { authenticated: true },
    request: { params: ClubSwapParamsSchema, body: TakeDutySwapSchema },
    response: z.null(),
    status: 204,
  })
  async takeSwap(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; swapId: string },
    @Body() body: TakeDutySwapInput,
  ): Promise<null> {
    await this.duties.takeSwap(
      tenantContext(authz, params.clubId),
      this.family(authz),
      params.swapId,
      body,
    );
    return null;
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/duty-swaps/:swapId/accept",
    summary: "Accept a request to take over one's shift",
    tags: TAGS,
    access: { authenticated: true },
    request: { params: ClubSwapParamsSchema },
    response: z.null(),
    status: 204,
  })
  async acceptSwap(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; swapId: string },
  ): Promise<null> {
    await this.duties.answerSwap(
      tenantContext(authz, params.clubId),
      this.family(authz),
      params.swapId,
      true,
    );
    return null;
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/duty-swaps/:swapId/decline",
    summary: "Decline a request to take over one's shift",
    tags: TAGS,
    access: { authenticated: true },
    request: { params: ClubSwapParamsSchema },
    response: z.null(),
    status: 204,
  })
  async declineSwap(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; swapId: string },
  ): Promise<null> {
    await this.duties.answerSwap(
      tenantContext(authz, params.clubId),
      this.family(authz),
      params.swapId,
      false,
    );
    return null;
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/duty-swaps/:swapId/withdraw",
    summary: "Withdraw one's own offer or request before it is answered",
    tags: TAGS,
    access: { authenticated: true },
    request: { params: ClubSwapParamsSchema },
    response: z.null(),
    status: 204,
  })
  async withdrawSwap(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; swapId: string },
  ): Promise<null> {
    await this.duties.withdrawSwap(
      tenantContext(authz, params.clubId),
      this.family(authz),
      params.swapId,
    );
    return null;
  }

  // --- "Mina uppgifter" -------------------------------------------------------------

  @Endpoint({
    method: "GET",
    path: "me/duties",
    summary: "My family's duties in a club: quotas, open shifts, swaps",
    tags: TAGS,
    access: { authenticated: true },
    request: { query: MyDutiesQuerySchema },
    response: MyDutiesSchema,
  })
  async mine(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: { clubId: string },
  ): Promise<MyDuties> {
    const family = this.family(authz);
    const result = await this.duties.myDuties(tenantContext(authz, query.clubId), family);
    const list = await this.shiftList(
      authz,
      query.clubId,
      { shifts: result.shifts, assignments: result.assignments, timeZone: result.timeZone },
      false,
      result.visibility,
    );
    const byId = new Map(list.items.map((x) => [x.id, x]));
    const persons = await this.persons(authz, query.clubId, [
      ...result.quotas.map((q) => q.playerId),
      ...result.swaps.flatMap((w) => [w.holderPersonId, w.takerPersonId]),
    ]);
    const own = new Set([family.me, ...family.wardIds]);
    const swaps: DutySwap[] = result.swaps.flatMap((w: SwapRow) => {
      const shift = byId.get(w.shiftId);
      if (!shift) return [];
      const holderIsFamily = own.has(w.holderPersonId);
      const named = shift.assignments.some((a) => a.person !== null && !a.mine) || holderIsFamily;
      return [
        {
          id: w.id,
          kind: w.kind,
          status: w.status,
          assignmentId: w.assignmentId,
          shift: {
            id: shift.id,
            clubId: shift.clubId,
            groupId: shift.groupId,
            groupName: shift.groupName,
            title: shift.title,
            startsAt: shift.startsAt,
            endsAt: shift.endsAt,
          },
          holder: named ? (persons.get(w.holderPersonId) ?? null) : null,
          taker: (w.takerPersonId && persons.get(w.takerPersonId)) || null,
          mine: own.has(w.createdByPersonId),
          canTake: w.kind === "offer" && !holderIsFamily,
          canAccept: w.kind === "request" && holderIsFamily,
        },
      ];
    });
    return {
      clubId: query.clubId,
      quotas: result.quotas.map((q) => ({
        groupId: q.groupId,
        groupName: q.groupName,
        seasonId: q.seasonId,
        player: persons.get(q.playerId) ?? null,
        shiftsPerPlayer: q.shiftsPerPlayer,
        done: q.done,
        planned: q.planned,
      })),
      openShifts: list.items.filter((x) => result.openShifts.some((o) => o.id === x.id)),
      swaps,
    };
  }

  // --- Statistics ------------------------------------------------------------------

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/groups/:groupId/duty-stats",
    summary:
      "Shifts and hours per person and player in a season, as CSV (also for grant reporting)",
    tags: TAGS,
    access: { permission: "group.duties.manage", resource: "group" },
    request: { params: GroupDutyShiftParamsSchema, query: DutyStatsQuerySchema },
    response: z.string(),
    responseType: "text/csv",
  })
  async stats(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; groupId: string },
    @Query() query: { seasonId: string },
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<string> {
    const result = await this.duties.stats(
      tenantContext(authz, params.clubId),
      params.groupId,
      query.seasonId,
    );
    const persons = await this.persons(
      authz,
      params.clubId,
      result.rows.flatMap((r) => [r.personId, r.countsForPersonId]),
    );
    const name = (id: string | null) => (id ? (persons.get(id)?.displayName ?? "") : "");
    // One row per person and player: shifts and hours done, shifts planned and missed.
    const totals = new Map<
      string,
      {
        person: string;
        player: string;
        done: number;
        hours: number;
        planned: number;
        missed: number;
      }
    >();
    for (const r of result.rows) {
      const key = `${r.personId}|${r.countsForPersonId ?? ""}`;
      const row = totals.get(key) ?? {
        person: name(r.personId),
        player: name(r.countsForPersonId),
        done: 0,
        hours: 0,
        planned: 0,
        missed: 0,
      };
      if (r.status === "done") {
        row.done += 1;
        row.hours += r.minutes / 60;
      } else if (r.status === "planned") row.planned += 1;
      else row.missed += 1;
      totals.set(key, row);
    }
    const rows: string[][] = [
      ["person", "counts_for", "shifts_done", "hours_done", "shifts_planned", "shifts_missed"],
      ...[...totals.values()]
        .sort((a, b) => a.person.localeCompare(b.person))
        .map((t) => [
          t.person,
          t.player,
          String(t.done),
          t.hours.toFixed(1),
          String(t.planned),
          String(t.missed),
        ]),
    ];
    void reply.header("content-type", "text/csv; charset=utf-8");
    void reply.header("content-disposition", `attachment; filename="duties-${query.seasonId}.csv"`);
    void reply.header("cache-control", "no-store");
    return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
  }
}

export type { ShiftScope };
