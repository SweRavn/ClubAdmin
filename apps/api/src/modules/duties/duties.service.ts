// SPDX-License-Identifier: AGPL-3.0-only
// Volunteer duties (P2.6 part A, ADR 0050 and its amendment of 2026-11-18).
//
// - Duty types: the club's catalogue. `alone_with_children` only where the
//   club's country pack allows it (`dutyRules.aloneWithChildren`) and the
//   club has not forbidden it itself; where forbidden, no type is created or
//   changed to it and such types get no new shifts.
// - Shifts: tasks of kind `duty_shift` (ADR 0052) in a group or the club,
//   optionally of an activity or event of it, with a type, place, the number
//   needed and a note.
// - Sign-up (first come): the caller signs up themselves or a child they may
//   act for (the type's minimum age), counting for one of the family's
//   players of the shift's group (chosen when there is exactly one; club
//   shifts: the family's club members, or nobody for an adult volunteer).
//   Assignment by the shift's planners with the same rules for "counts for".
// - Quotas: shifts per player and season in a group; counted by the player
//   a shift counts for, done and planned apart.
// No background check in P2.6 (P2.8 adds it to eligibility).

import { ageOn, getCountryPack, isSupportedCountry } from "@clubadmin/country-packs";
import {
  type ActorContext,
  audit,
  type Database,
  outbox,
  type TenantContext,
  type Tx,
} from "@clubadmin/db";
import {
  type AssignDutyInput,
  AssignDutySchema,
  type CreateDutyShiftInput,
  CreateDutyShiftSchema,
  type CreateDutySwapInput,
  CreateDutySwapSchema,
  type CreateDutyTypeInput,
  CreateDutyTypeSchema,
  DUTY_SHIFT_LIST_MAX,
  type DutySignUpInput,
  DutySignUpSchema,
  type DutyVisibility,
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
} from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { actorPersonId, parseInput } from "../../platform/domain/run.ts";
import { BackgroundChecksService } from "../background-checks/index.ts";
import type { ClubsService } from "../clubs/index.ts";
import * as repo from "./duties.repository.ts";

export type {
  AssignmentRow,
  DutySettingsRow,
  DutyTypeRow,
  MyDutyRow,
  ShiftRow,
  StatsRow,
  SwapRow,
} from "./duties.repository.ts";

/** Where shifts live: a group's, or the club's own (no group). */
export type ShiftScope = { groupId: string } | { club: true };

/** The caller's family as the API knows it: themselves and the children they may act for. */
export interface Family {
  me: string;
  wardIds: readonly string[];
}

export class DutiesService {
  private readonly db: Database;
  private readonly clubs: ClubsService;
  private readonly checks: BackgroundChecksService | undefined;
  private readonly now: () => Date;

  constructor(
    db: Database,
    deps: {
      clubs: ClubsService;
      /** P2.8: a duty that needs a background check is refused without a valid one. */
      checks?: BackgroundChecksService;
      now?: () => Date;
    },
  ) {
    this.db = db;
    this.clubs = deps.clubs;
    this.checks = deps.checks;
    this.now = deps.now ?? (() => new Date());
  }

  // --- The country rule ----------------------------------------------------------

  /** Whether the country pack forbids an adult alone with children (unknown pack: forbidden). */
  private async countryForbids(tx: Tx, clubId: string): Promise<boolean> {
    const club = await this.clubs.getClubInTx(tx, clubId);
    return isSupportedCountry(club.country)
      ? getCountryPack(club.country).dutyRules.aloneWithChildren === "forbidden"
      : true;
  }

  private async aloneAllowed(tx: Tx, clubId: string): Promise<boolean> {
    if (await this.countryForbids(tx, clubId)) return false;
    return !(await repo.settings(tx)).aloneWithChildrenForbidden;
  }

  // --- Duty types ----------------------------------------------------------------

  listTypes(
    context: TenantContext,
    includeArchived: boolean,
  ): Promise<{ types: repo.DutyTypeRow[]; aloneWithChildrenAllowed: boolean }> {
    return this.db.withTenant(context, async (tx) => ({
      types: await repo.types(tx, includeArchived),
      aloneWithChildrenAllowed: await this.aloneAllowed(tx, context.clubId),
    }));
  }

  createType(context: TenantContext, input: CreateDutyTypeInput): Promise<{ id: string }> {
    const data = parseInput(CreateDutyTypeSchema, input);
    return this.db.withTenant(context, async (tx) => {
      if (
        data.childContact === "alone_with_children" &&
        !(await this.aloneAllowed(tx, context.clubId))
      ) {
        throw new DomainError("duty_alone_with_children_forbidden");
      }
      const id = await repo.insertType(tx, context.clubId, {
        name: data.name,
        instruction: data.instruction ?? null,
        instructionDocumentIds: data.instructionDocumentIds,
        minAge: data.minAge ?? null,
        childContact: data.childContact,
        requiredQualifications: data.requiredQualifications,
      });
      if (!id) throw new DomainError("duty_type_name_taken");
      await audit.record(tx, {
        action: "duty.type.created",
        resourceType: "club",
        resourceId: context.clubId,
        changedFields: ["name", "min_age", "child_contact"],
      });
      return { id };
    });
  }

  updateType(
    context: TenantContext,
    typeId: string,
    input: UpdateDutyTypeInput,
  ): Promise<repo.DutyTypeRow> {
    const data = parseInput(UpdateDutyTypeSchema, input);
    return this.db.withTenant(context, async (tx) => {
      const current = await repo.type(tx, typeId);
      if (!current) throw new DomainError("not_found");
      const next: repo.DutyTypeRow = {
        ...current,
        ...(data.name === undefined ? {} : { name: data.name }),
        ...(data.instruction === undefined ? {} : { instruction: data.instruction }),
        ...(data.instructionDocumentIds === undefined
          ? {}
          : { instructionDocumentIds: data.instructionDocumentIds }),
        ...(data.minAge === undefined ? {} : { minAge: data.minAge }),
        ...(data.childContact === undefined ? {} : { childContact: data.childContact }),
        ...(data.requiredQualifications === undefined
          ? {}
          : { requiredQualifications: data.requiredQualifications }),
        ...(data.archived === undefined ? {} : { archived: data.archived }),
      };
      if (
        next.childContact === "alone_with_children" &&
        current.childContact !== "alone_with_children" &&
        !(await this.aloneAllowed(tx, context.clubId))
      ) {
        throw new DomainError("duty_alone_with_children_forbidden");
      }
      if (!next.archived && (await repo.typeNameTaken(tx, next.name, typeId))) {
        throw new DomainError("duty_type_name_taken");
      }
      await repo.updateType(tx, next);
      await audit.record(tx, {
        action: "duty.type.updated",
        resourceType: "club",
        resourceId: context.clubId,
        changedFields: Object.keys(data),
      });
      return next;
    });
  }

  // --- Settings ------------------------------------------------------------------

  getSettings(
    context: TenantContext,
  ): Promise<repo.DutySettingsRow & { countryForbidsAloneWithChildren: boolean }> {
    return this.db.withTenant(context, async (tx) => ({
      ...(await repo.settings(tx)),
      countryForbidsAloneWithChildren: await this.countryForbids(tx, context.clubId),
    }));
  }

  putSettings(context: TenantContext, input: PutDutySettingsInput): Promise<void> {
    const data = parseInput(PutDutySettingsSchema, input);
    return this.db.withTenant(context, async (tx) => {
      // Where the country forbids it, the club's own ban stays on (never weaker).
      const forbidden =
        data.aloneWithChildrenForbidden || (await this.countryForbids(tx, context.clubId));
      await repo.putSettings(tx, context.clubId, {
        ...data,
        aloneWithChildrenForbidden: forbidden,
      });
      await audit.record(tx, {
        action: "duty.settings.updated",
        resourceType: "club",
        resourceId: context.clubId,
        changedFields: [
          "visibility",
          "groups_may_change_visibility",
          "alone_with_children_forbidden",
        ],
      });
    });
  }

  // --- Shifts --------------------------------------------------------------------

  /** Shifts with their assignments: a group's or the club's in a period, or an activity's. */
  listShifts(
    context: TenantContext,
    where: ShiftScope | { activityId: string },
    range: { from: Date; to: Date } | null,
  ): Promise<{ shifts: repo.ShiftRow[]; assignments: repo.AssignmentRow[]; timeZone: string }> {
    return this.db.withTenant(context, async (tx) => {
      const shifts = await repo.shifts(tx, where, range, DUTY_SHIFT_LIST_MAX);
      const club = await this.clubs.getClubInTx(tx, context.clubId);
      return {
        shifts,
        assignments: await repo.assignments(
          tx,
          shifts.map((s) => s.id),
        ),
        timeZone: club.timeZone,
      };
    });
  }

  /** A shift of the scope (a group's in its group, the club's without one). */
  private async scopedShift(
    tx: Tx,
    scope: ShiftScope,
    shiftId: string,
    lock = false,
  ): Promise<repo.ShiftRow> {
    const found = await repo.shift(tx, shiftId, lock);
    if (!found) throw new DomainError("not_found");
    if ("groupId" in scope && found.groupId !== scope.groupId) throw new DomainError("not_found");
    return found;
  }

  createShift(
    context: TenantContext,
    scope: ShiftScope,
    input: CreateDutyShiftInput,
  ): Promise<{ id: string }> {
    const data = parseInput(CreateDutyShiftSchema, input);
    const me = actorPersonId(context);
    const groupId = "groupId" in scope ? scope.groupId : null;
    return this.db.withTenant(context, async (tx) => {
      const type = await repo.type(tx, data.dutyTypeId);
      if (!type) throw new DomainError("not_found");
      if (type.archived) throw new DomainError("duty_type_archived");
      if (
        type.childContact === "alone_with_children" &&
        !(await this.aloneAllowed(tx, context.clubId))
      ) {
        throw new DomainError("duty_alone_with_children_forbidden");
      }
      if (data.locationId && !(await repo.locationValid(tx, data.locationId))) {
        throw new DomainError("not_found");
      }
      if (data.activityId && !(await repo.activityInGroup(tx, data.activityId, groupId))) {
        throw new DomainError("duty_source_invalid");
      }
      if (data.eventId && !(await repo.eventInGroup(tx, data.eventId, groupId))) {
        throw new DomainError("duty_source_invalid");
      }
      const id = await repo.insertShift(tx, {
        clubId: context.clubId,
        groupId,
        dutyTypeId: type.id,
        title: data.title ?? type.name,
        note: data.note ?? null,
        startsAt: data.startsAt,
        endsAt: data.endsAt,
        locationId: data.locationId ?? null,
        needed: data.needed,
        activityId: data.activityId ?? null,
        eventId: data.eventId ?? null,
        by: me,
      });
      await audit.record(tx, {
        action: "duty.shift.created",
        resourceType: groupId ? "group" : "club",
        resourceId: groupId ?? context.clubId,
        changedFields: ["duty_type_id", "starts_at", "ends_at", "needed"],
      });
      return { id };
    });
  }

  // --- Programmes (P2.9, ADR 0054) ---------------------------------------------------

  /**
   * Why each of these duty types cannot be laid out (archived, the country
   * rule on being alone with children, or not the club's); absent when it can.
   */
  async typeRefusalsInTx(
    tx: Tx,
    clubId: string,
    typeIds: readonly string[],
  ): Promise<
    Map<string, "not_found" | "duty_type_archived" | "duty_alone_with_children_forbidden">
  > {
    const types = await repo.typesById(tx, typeIds);
    const out = new Map<
      string,
      "not_found" | "duty_type_archived" | "duty_alone_with_children_forbidden"
    >();
    const found = new Map(types.map((t) => [t.id, t]));
    const alone = types.some((t) => t.childContact === "alone_with_children")
      ? await this.aloneAllowed(tx, clubId)
      : true;
    for (const id of new Set(typeIds)) {
      const type = found.get(id);
      if (!type) out.set(id, "not_found");
      else if (type.archived) out.set(id, "duty_type_archived");
      else if (type.childContact === "alone_with_children" && !alone) {
        out.set(id, "duty_alone_with_children_forbidden");
      }
    }
    return out;
  }

  /** The names of duty types (archived too), for templates and previews. */
  async typesByIdInTx(tx: Tx, typeIds: readonly string[]): Promise<repo.DutyTypeRow[]> {
    return repo.typesById(tx, typeIds);
  }

  /**
   * A programme's shifts in one statement (the caller checked the types with
   * typeRefusalsInTx), audited in one more.
   */
  async createProgrammeShiftsInTx(
    tx: Tx,
    context: TenantContext,
    programmeId: string,
    shifts: readonly {
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
      eventId: string | null;
    }[],
  ): Promise<void> {
    if (shifts.length === 0) return;
    const refused = await this.typeRefusalsInTx(
      tx,
      context.clubId,
      shifts.map((s) => s.dutyTypeId),
    );
    const [first] = refused.values();
    if (first) throw new DomainError(first);
    const by = actorPersonId(context);
    await repo.insertShifts(
      tx,
      shifts.map((s) => ({
        ...s,
        clubId: context.clubId,
        startsAt: s.startsAt.toISOString(),
        endsAt: s.endsAt.toISOString(),
        programmeId,
        by,
      })),
    );
    await audit.recordMany(
      tx,
      shifts.map((s) => ({
        action: "duty.shift.created" as const,
        resourceType: s.groupId ? "group" : "club",
        resourceId: s.groupId ?? context.clubId,
        changedFields: ["duty_type_id", "starts_at", "ends_at", "needed"],
      })),
    );
  }

  /** Puts existing shifts in a programme (an event's, P2.9); one statement. */
  async assignProgrammeInTx(tx: Tx, programmeId: string, ids: readonly string[]): Promise<void> {
    await repo.setProgramme(tx, programmeId, ids);
  }

  /** Shifts of a programme (a day of it), of activities or of an event. */
  shiftsOfInTx(tx: Tx, where: Parameters<typeof repo.shiftsOf>[1]): Promise<repo.ShiftRow[]> {
    return repo.shiftsOf(tx, where);
  }

  /** A group's shifts starting in a range. */
  groupShiftsInTx(
    tx: Tx,
    groupId: string,
    range: { from: Date; to: Date },
  ): Promise<repo.ShiftRow[]> {
    return repo.shifts(tx, { groupId }, range, DUTY_SHIFT_LIST_MAX);
  }

  assignmentsInTx(tx: Tx, shiftIds: readonly string[]): Promise<repo.AssignmentRow[]> {
    return repo.assignments(tx, shiftIds);
  }

  /** Deletes shifts nobody has (the caller checked), audited in one statement. */
  async deleteProgrammeShiftsInTx(
    tx: Tx,
    context: TenantContext,
    shifts: readonly repo.ShiftRow[],
  ): Promise<void> {
    if (shifts.length === 0) return;
    await repo.deleteShifts(
      tx,
      shifts.map((s) => s.id),
    );
    await audit.recordMany(
      tx,
      shifts.map((s) => ({
        action: "duty.shift.deleted" as const,
        resourceType: s.groupId ? "group" : "club",
        resourceId: s.groupId ?? context.clubId,
      })),
    );
  }

  updateShift(
    context: TenantContext,
    scope: ShiftScope,
    shiftId: string,
    input: UpdateDutyShiftInput,
  ): Promise<void> {
    const data = parseInput(UpdateDutyShiftSchema, input);
    return this.db.withTenant(context, async (tx) => {
      const current = await this.scopedShift(tx, scope, shiftId, true);
      const next: repo.ShiftRow = {
        ...current,
        ...(data.title === undefined ? {} : { title: data.title ?? current.typeName }),
        ...(data.note === undefined ? {} : { note: data.note }),
        ...(data.startsAt === undefined ? {} : { startsAt: new Date(data.startsAt) }),
        ...(data.endsAt === undefined ? {} : { endsAt: new Date(data.endsAt) }),
        ...(data.locationId === undefined ? {} : { locationId: data.locationId }),
        ...(data.needed === undefined ? {} : { needed: data.needed }),
      };
      if (next.endsAt.getTime() <= next.startsAt.getTime()) {
        throw new DomainError("invalid_input");
      }
      if (
        data.locationId &&
        data.locationId !== current.locationId &&
        !(await repo.locationValid(tx, data.locationId))
      ) {
        throw new DomainError("not_found");
      }
      if (next.needed < current.needed) {
        const filled = (await repo.assignments(tx, [shiftId])).length;
        if (filled > next.needed) throw new DomainError("duty_needed_below_filled");
      }
      await repo.updateShift(tx, next);
      await audit.record(tx, {
        action: "duty.shift.updated",
        resourceType: current.groupId ? "group" : "club",
        resourceId: current.groupId ?? context.clubId,
        changedFields: Object.keys(data),
      });
    });
  }

  deleteShift(context: TenantContext, scope: ShiftScope, shiftId: string): Promise<void> {
    return this.db.withTenant(context, async (tx) => {
      const current = await this.scopedShift(tx, scope, shiftId, true);
      await repo.deleteShift(tx, shiftId);
      await audit.record(tx, {
        action: "duty.shift.deleted",
        resourceType: current.groupId ? "group" : "club",
        resourceId: current.groupId ?? context.clubId,
        changedFields: [],
      });
    });
  }

  // --- Background checks (P2.8) ---------------------------------------------------

  /**
   * For a list of shifts: which the caller may not take for want of a
   * background check, and which assignments lack one (the planners' list).
   * Nothing is read unless a shift needs a check.
   */
  async backgroundCheckFlags(
    context: TenantContext,
    shifts: readonly repo.ShiftRow[],
    assignments: readonly repo.AssignmentRow[],
    personId: string | null,
  ): Promise<{ blockedShiftIds: Set<string>; missingAssignmentIds: Set<string> }> {
    const out = { blockedShiftIds: new Set<string>(), missingAssignmentIds: new Set<string>() };
    const checks = this.checks;
    if (!checks) return out;
    const byCategory = new Map<string, repo.ShiftRow[]>();
    for (const s of shifts) {
      const category = BackgroundChecksService.dutyCategory({
        childContact: s.childContact,
        category: s.checkCategory,
      });
      if (category) byCategory.set(category, [...(byCategory.get(category) ?? []), s]);
    }
    if (byCategory.size === 0) return out;
    await this.db.withTenant(context, async (tx) => {
      for (const [category, list] of byCategory) {
        const ids = new Set(list.map((s) => s.id));
        const of = assignments.filter((a) => ids.has(a.shiftId));
        const people = [
          ...new Set([...(personId ? [personId] : []), ...of.map((a) => a.personId)]),
        ];
        const lacking = await checks.lackingInTx(
          tx,
          context.clubId,
          people,
          category as Parameters<typeof checks.lackingInTx>[3],
        );
        if (personId && lacking.has(personId)) for (const id of ids) out.blockedShiftIds.add(id);
        for (const a of of) if (lacking.has(a.personId)) out.missingAssignmentIds.add(a.id);
      }
    });
    return out;
  }

  // --- Who may do it and whom it counts for --------------------------------------

  /** The minimum age, and (P2.8) the background check the type's contact with children needs. */
  private async requireEligible(tx: Tx, shift: repo.ShiftRow, personId: string): Promise<void> {
    if (shift.minAge !== null) {
      const facts = (await repo.ages(tx, [personId])).get(personId);
      const tooYoung = facts?.birthDate
        ? ageOn(facts.birthDate, shift.startsAt) < shift.minAge
        : facts?.hasGuardian === true;
      if (tooYoung) throw new DomainError("duty_too_young");
    }
    // P2.8: a type with contact with children needs the club's background check.
    await this.checks?.requireForDutyInTx(
      tx,
      shift.clubId,
      personId,
      BackgroundChecksService.dutyCategory({
        childContact: shift.childContact,
        category: shift.checkCategory,
      }),
    );
  }

  /** The players a shift of the family could count for: participants of its group, or the club's members. */
  private async eligiblePlayers(
    tx: Tx,
    shift: repo.ShiftRow,
    people: readonly string[],
  ): Promise<string[]> {
    if (shift.groupId) return repo.groupParticipants(tx, shift.groupId, people);
    return [...(await repo.clubMembers(tx, people))];
  }

  /** Whom it counts for: the given player if eligible, else the only one, else nobody (club shifts). */
  private async countsFor(
    tx: Tx,
    shift: repo.ShiftRow,
    candidates: readonly string[],
    given: string | null | undefined,
  ): Promise<string | null> {
    const eligible = await this.eligiblePlayers(tx, shift, candidates);
    if (given) {
      if (!eligible.includes(given)) throw new DomainError("duty_counts_for_invalid");
      return given;
    }
    if (eligible.length === 1) return eligible[0]!;
    if (eligible.length > 1) throw new DomainError("duty_counts_for_required");
    // Nobody to count for: a group's shift needs one of its players in the family.
    if (shift.groupId) throw new DomainError("duty_counts_for_invalid");
    return null;
  }

  private requireOpen(shift: repo.ShiftRow): void {
    if (shift.startsAt.getTime() <= this.now().getTime()) {
      throw new DomainError("duty_shift_started");
    }
  }

  private async requireRoom(tx: Tx, shift: repo.ShiftRow): Promise<void> {
    const filled = (await repo.assignments(tx, [shift.id])).length;
    if (filled >= shift.needed) throw new DomainError("duty_shift_full");
  }

  // --- Sign-up -------------------------------------------------------------------

  signUp(
    context: TenantContext,
    family: Family,
    shiftId: string,
    input: DutySignUpInput,
  ): Promise<{ id: string; countsForPersonId: string | null }> {
    const data = parseInput(DutySignUpSchema, input);
    const worker = data.personId ?? family.me;
    if (worker !== family.me && !family.wardIds.includes(worker)) {
      throw new DomainError("duty_person_invalid");
    }
    return this.db.withTenant(context, async (tx) => {
      const shift = await repo.shift(tx, shiftId, true);
      if (!shift) throw new DomainError("not_found");
      this.requireOpen(shift);
      await this.requireEligible(tx, shift, worker);
      const countsFor = await this.countsFor(
        tx,
        shift,
        [family.me, ...family.wardIds],
        data.countsForPersonId,
      );
      // A club shift with nobody to count for is an adult member's own work.
      if (countsFor === null && !(await repo.clubMembers(tx, [worker])).has(worker)) {
        throw new DomainError("duty_counts_for_invalid");
      }
      await this.requireRoom(tx, shift);
      const id = await repo.insertAssignment(tx, {
        clubId: shift.clubId,
        shiftId,
        personId: worker,
        countsForPersonId: countsFor,
        source: "signup",
      });
      if (!id) throw new DomainError("duty_already_assigned");
      await audit.record(tx, {
        action: "duty.assignment.registered",
        resourceType: shift.groupId ? "group" : "club",
        resourceId: shift.groupId ?? shift.clubId,
        changedFields: ["person_id", "counts_for_person_id"],
      });
      return { id, countsForPersonId: countsFor };
    });
  }

  /** Cancels one's own (or one's child's) sign-up before the shift; a leader's assignment stays. */
  cancelSignUp(
    context: TenantContext,
    family: Family,
    shiftId: string,
    assignmentId: string,
  ): Promise<void> {
    const people = new Set([family.me, ...family.wardIds]);
    return this.db.withTenant(context, async (tx) => {
      const shift = await repo.shift(tx, shiftId, true);
      if (!shift) throw new DomainError("not_found");
      const assignment = (await repo.assignments(tx, [shiftId])).find((a) => a.id === assignmentId);
      if (
        !assignment ||
        !(
          people.has(assignment.personId) ||
          (assignment.countsForPersonId && people.has(assignment.countsForPersonId))
        )
      ) {
        throw new DomainError("not_found");
      }
      if (assignment.source === "assigned") throw new DomainError("duty_assigned_by_leader");
      this.requireOpen(shift);
      await repo.deleteAssignment(tx, assignmentId);
      await audit.record(tx, {
        action: "duty.assignment.cancelled",
        resourceType: shift.groupId ? "group" : "club",
        resourceId: shift.groupId ?? shift.clubId,
        changedFields: ["person_id"],
      });
    });
  }

  // --- Assignment by the planners ------------------------------------------------

  assign(
    context: TenantContext,
    scope: ShiftScope,
    shiftId: string,
    input: AssignDutyInput,
  ): Promise<{ id: string; countsForPersonId: string | null }> {
    const data = parseInput(AssignDutySchema, input);
    return this.db.withTenant(context, async (tx) => {
      const shift = await this.scopedShift(tx, scope, shiftId, true);
      await this.requireEligible(tx, shift, data.personId);
      // The worker's family as the club knows it: themselves and their wards in the club.
      const family = [data.personId, ...(await repo.wardsOf(tx, data.personId))];
      const countsFor = await this.countsFor(tx, shift, family, data.countsForPersonId);
      if (countsFor === null && !(await repo.clubMembers(tx, [data.personId])).has(data.personId)) {
        throw new DomainError("duty_counts_for_invalid");
      }
      await this.requireRoom(tx, shift);
      const id = await repo.insertAssignment(tx, {
        clubId: shift.clubId,
        shiftId,
        personId: data.personId,
        countsForPersonId: countsFor,
        source: "assigned",
      });
      if (!id) throw new DomainError("duty_already_assigned");
      await audit.record(tx, {
        action: "duty.assignment.assigned",
        resourceType: shift.groupId ? "group" : "club",
        resourceId: shift.groupId ?? shift.clubId,
        changedFields: ["person_id", "counts_for_person_id"],
      });
      await this.tell(tx, actorPersonId(context), shift, "assigned", [data.personId]);
      return { id, countsForPersonId: countsFor };
    });
  }

  unassign(
    context: TenantContext,
    scope: ShiftScope,
    shiftId: string,
    assignmentId: string,
  ): Promise<void> {
    return this.db.withTenant(context, async (tx) => {
      const shift = await this.scopedShift(tx, scope, shiftId, true);
      const assignment = (await repo.assignments(tx, [shiftId])).find((a) => a.id === assignmentId);
      if (!assignment) throw new DomainError("not_found");
      await repo.deleteAssignment(tx, assignmentId);
      await audit.record(tx, {
        action: "duty.assignment.unassigned",
        resourceType: shift.groupId ? "group" : "club",
        resourceId: shift.groupId ?? shift.clubId,
        changedFields: ["person_id"],
      });
      await this.tell(tx, actorPersonId(context), shift, "unassigned", [assignment.personId]);
    });
  }

  // --- Quotas --------------------------------------------------------------------

  /** The group's quota in a season and every player's shifts in it. */
  getQuota(
    context: TenantContext,
    groupId: string,
    seasonId: string,
  ): Promise<{
    shiftsPerPlayer: number | null;
    players: { personId: string; done: number; planned: number }[];
  }> {
    return this.db.withTenant(context, async (tx) => {
      if (!(await repo.season(tx, seasonId))) throw new DomainError("duty_season_invalid");
      const club = await this.clubs.getClubInTx(tx, context.clubId);
      const shiftsPerPlayer = await repo.quota(tx, groupId, seasonId);
      const players = await repo.groupParticipants(tx, groupId, null);
      const counts = await repo.quotaCounts(tx, groupId, seasonId, club.timeZone);
      return {
        shiftsPerPlayer,
        players: players.map((personId) => ({
          personId,
          done: counts.get(personId)?.done ?? 0,
          planned: counts.get(personId)?.planned ?? 0,
        })),
      };
    });
  }

  putQuota(context: TenantContext, groupId: string, input: PutDutyQuotaInput): Promise<void> {
    const data = parseInput(PutDutyQuotaSchema, input);
    return this.db.withTenant(context, async (tx) => {
      if (!(await repo.season(tx, data.seasonId))) throw new DomainError("duty_season_invalid");
      await repo.putQuota(tx, {
        clubId: context.clubId,
        groupId,
        seasonId: data.seasonId,
        shiftsPerPlayer: data.shiftsPerPlayer,
      });
      await audit.record(tx, {
        action: "duty.quota.set",
        resourceType: "group",
        resourceId: groupId,
        changedFields: ["shifts_per_player"],
      });
    });
  }

  // --- Notices -------------------------------------------------------------------

  /** Tells these people (never the actor) that a shift changed hands; the worker adds guardians. */
  private async tell(
    tx: Tx,
    actor: string,
    shift: repo.ShiftRow,
    kind: "assigned" | "unassigned" | "swap_requested" | "swapped" | "swap_declined",
    personIds: readonly (string | null)[],
  ): Promise<void> {
    const people = [...new Set(personIds.filter((p): p is string => !!p && p !== actor))];
    if (people.length === 0) return;
    await outbox.publish(tx, "duty.changed", {
      clubId: shift.clubId,
      kind,
      shiftId: shift.id,
      personIds: people.slice(0, 20),
    });
  }

  // --- Marking done or missed (the planners) ------------------------------------

  setStatus(
    context: TenantContext,
    scope: ShiftScope,
    shiftId: string,
    assignmentId: string,
    input: SetDutyStatusInput,
  ): Promise<void> {
    const data = parseInput(SetDutyStatusSchema, input);
    const me = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      const shift = await this.scopedShift(tx, scope, shiftId, true);
      if (data.status !== "planned" && shift.startsAt.getTime() > this.now().getTime()) {
        throw new DomainError("duty_shift_not_started");
      }
      const marked = await repo.setStatus(tx, {
        shiftId,
        assignmentId,
        status: data.status,
        by: me,
      });
      if (!marked) throw new DomainError("not_found");
      await audit.record(tx, {
        action: data.status === "done" ? "duty.assignment.completed" : "duty.assignment.updated",
        resourceType: shift.groupId ? "group" : "club",
        resourceId: shift.groupId ?? shift.clubId,
        changedFields: ["status"],
      });
    });
  }

  /** Past shifts with someone still planned ("Att markera"), newest first. */
  toMark(
    context: TenantContext,
    scope: ShiftScope,
  ): Promise<{ shifts: repo.ShiftRow[]; assignments: repo.AssignmentRow[]; timeZone: string }> {
    return this.db.withTenant(context, async (tx) => {
      const shifts = await repo.toMark(tx, scope, this.now(), 200);
      const club = await this.clubs.getClubInTx(tx, context.clubId);
      return {
        shifts,
        assignments: await repo.assignments(
          tx,
          shifts.map((s) => s.id),
        ),
        timeZone: club.timeZone,
      };
    });
  }

  // --- Visibility ----------------------------------------------------------------

  /** What applies in these groups (a group's own choice when the club allows it). */
  async visibilityInTx(
    tx: Tx,
    groupIds: readonly (string | null)[],
  ): Promise<{ club: DutyVisibility; groups: Map<string, DutyVisibility> }> {
    const settings = await repo.settings(tx);
    const ids = groupIds.filter((g): g is string => !!g);
    const own = settings.groupsMayChangeVisibility
      ? await repo.groupVisibilities(tx, ids)
      : new Map<string, DutyVisibility>();
    return {
      club: settings.visibility,
      groups: new Map(ids.map((g) => [g, own.get(g) ?? settings.visibility])),
    };
  }

  visibilityOf(
    context: TenantContext,
    groupIds: readonly (string | null)[],
  ): Promise<{ club: DutyVisibility; groups: Map<string, DutyVisibility> }> {
    return this.db.withTenant(context, (tx) => this.visibilityInTx(tx, groupIds));
  }

  getGroupSettings(
    context: TenantContext,
    groupId: string,
  ): Promise<{ visibility: DutyVisibility | null; effective: DutyVisibility; mayChange: boolean }> {
    return this.db.withTenant(context, async (tx) => {
      const settings = await repo.settings(tx);
      const own = await repo.groupVisibility(tx, groupId);
      return {
        visibility: own,
        effective: settings.groupsMayChangeVisibility
          ? (own ?? settings.visibility)
          : settings.visibility,
        mayChange: settings.groupsMayChangeVisibility,
      };
    });
  }

  putGroupSettings(
    context: TenantContext,
    groupId: string,
    input: PutGroupDutySettingsInput,
  ): Promise<void> {
    const data = parseInput(PutGroupDutySettingsSchema, input);
    return this.db.withTenant(context, async (tx) => {
      if (!(await repo.settings(tx)).groupsMayChangeVisibility) {
        throw new DomainError("duty_visibility_locked");
      }
      await repo.putGroupVisibility(tx, {
        clubId: context.clubId,
        groupId,
        visibility: data.visibility,
      });
      await audit.record(tx, {
        action: "duty.settings.updated",
        resourceType: "group",
        resourceId: groupId,
        changedFields: ["visibility"],
      });
    });
  }

  // --- Swaps ---------------------------------------------------------------------

  private static holds(family: Family, a: { personId: string; countsForPersonId: string | null }) {
    const people = new Set([family.me, ...family.wardIds]);
    return (
      people.has(a.personId) || (a.countsForPersonId !== null && people.has(a.countsForPersonId))
    );
  }

  /** Offers one's shift, or asks to take over someone else's. */
  createSwap(
    context: TenantContext,
    family: Family,
    assignmentId: string,
    input: CreateDutySwapInput,
  ): Promise<{ id: string }> {
    const data = parseInput(CreateDutySwapSchema, input);
    const me = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      const assignment = await repo.assignment(tx, assignmentId);
      if (!assignment) throw new DomainError("not_found");
      const shift = await repo.shift(tx, assignment.shiftId, true);
      if (!shift) throw new DomainError("not_found");
      this.requireOpen(shift);
      const ownShift = DutiesService.holds(family, assignment);
      let taker: { personId: string; countsForPersonId: string | null } | null = null;
      if (data.kind === "offer") {
        if (!ownShift) throw new DomainError("not_found");
      } else {
        if (ownShift) throw new DomainError("duty_swap_own");
        taker = await this.taker(tx, family, shift, data.personId, data.countsForPersonId);
      }
      const id = await repo.insertSwap(tx, {
        clubId: shift.clubId,
        assignmentId,
        kind: data.kind,
        by: me,
        takerPersonId: taker?.personId ?? null,
        takerCountsForPersonId: taker?.countsForPersonId ?? null,
      });
      if (!id) throw new DomainError("duty_swap_open");
      await audit.record(tx, {
        action: data.kind === "offer" ? "duty.swap.offered" : "duty.swap.requested",
        resourceType: shift.groupId ? "group" : "club",
        resourceId: shift.groupId ?? shift.clubId,
        changedFields: ["status"],
      });
      if (data.kind === "request") {
        await this.tell(tx, me, shift, "swap_requested", [assignment.personId]);
      }
      return { id };
    });
  }

  /** Who in the caller's family would take a shift, and whom it would count for. */
  private async taker(
    tx: Tx,
    family: Family,
    shift: repo.ShiftRow,
    personId: string | null | undefined,
    countsForPersonId: string | null | undefined,
  ): Promise<{ personId: string; countsForPersonId: string | null }> {
    const worker = personId ?? family.me;
    if (worker !== family.me && !family.wardIds.includes(worker)) {
      throw new DomainError("duty_person_invalid");
    }
    await this.requireEligible(tx, shift, worker);
    const countsFor = await this.countsFor(
      tx,
      shift,
      [family.me, ...family.wardIds],
      countsForPersonId,
    );
    if (countsFor === null && !(await repo.clubMembers(tx, [worker])).has(worker)) {
      throw new DomainError("duty_counts_for_invalid");
    }
    return { personId: worker, countsForPersonId: countsFor };
  }

  /** Takes an offered shift (the confirmation). */
  takeSwap(
    context: TenantContext,
    family: Family,
    swapId: string,
    input: TakeDutySwapInput,
  ): Promise<void> {
    const data = parseInput(TakeDutySwapSchema, input);
    const me = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      const found = await repo.swap(tx, swapId);
      if (!found || found.kind !== "offer") throw new DomainError("not_found");
      if (found.status !== "open") throw new DomainError("duty_swap_closed");
      const shift = await repo.shift(tx, found.shiftId, true);
      if (!shift) throw new DomainError("not_found");
      this.requireOpen(shift);
      const assignment = (await repo.assignment(tx, found.assignmentId))!;
      if (DutiesService.holds(family, assignment)) throw new DomainError("duty_swap_own");
      const taker = await this.taker(tx, family, shift, data.personId, data.countsForPersonId);
      if (!(await repo.transfer(tx, { assignmentId: assignment.id, ...taker }))) {
        throw new DomainError("duty_already_assigned");
      }
      await repo.closeSwap(tx, swapId, "done", taker);
      await audit.record(tx, {
        action: "duty.swap.accepted",
        resourceType: shift.groupId ? "group" : "club",
        resourceId: shift.groupId ?? shift.clubId,
        changedFields: ["person_id", "counts_for_person_id"],
      });
      await this.tell(tx, me, shift, "swapped", [assignment.personId, found.createdByPersonId]);
    });
  }

  /** The holder answers a request to take over their shift. */
  answerSwap(
    context: TenantContext,
    family: Family,
    swapId: string,
    accept: boolean,
  ): Promise<void> {
    const me = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      const found = await repo.swap(tx, swapId);
      if (!found || found.kind !== "request") throw new DomainError("not_found");
      const assignment = (await repo.assignment(tx, found.assignmentId))!;
      if (!DutiesService.holds(family, assignment)) throw new DomainError("not_found");
      if (found.status !== "open") throw new DomainError("duty_swap_closed");
      const shift = await repo.shift(tx, found.shiftId, true);
      if (!shift) throw new DomainError("not_found");
      if (accept) {
        this.requireOpen(shift);
        const moved = await repo.transfer(tx, {
          assignmentId: assignment.id,
          personId: found.takerPersonId!,
          countsForPersonId: found.takerCountsForPersonId,
        });
        if (!moved) throw new DomainError("duty_already_assigned");
      }
      await repo.closeSwap(tx, swapId, accept ? "done" : "declined");
      await audit.record(tx, {
        action: accept ? "duty.swap.accepted" : "duty.swap.declined",
        resourceType: shift.groupId ? "group" : "club",
        resourceId: shift.groupId ?? shift.clubId,
        changedFields: accept ? ["person_id", "counts_for_person_id"] : ["status"],
      });
      await this.tell(tx, me, shift, accept ? "swapped" : "swap_declined", [
        found.createdByPersonId,
        found.takerPersonId,
      ]);
    });
  }

  /** The one who offered or asked withdraws it before it is answered. */
  withdrawSwap(context: TenantContext, family: Family, swapId: string): Promise<void> {
    const people = new Set([family.me, ...family.wardIds]);
    return this.db.withTenant(context, async (tx) => {
      const found = await repo.swap(tx, swapId);
      if (!found || !people.has(found.createdByPersonId)) throw new DomainError("not_found");
      if (found.status !== "open") throw new DomainError("duty_swap_closed");
      const shift = await repo.shift(tx, found.shiftId);
      await repo.closeSwap(tx, swapId, "withdrawn");
      await audit.record(tx, {
        action: "duty.swap.withdrawn",
        resourceType: shift?.groupId ? "group" : "club",
        resourceId: shift?.groupId ?? context.clubId,
        changedFields: ["status"],
      });
    });
  }

  // --- "Mina uppgifter" -----------------------------------------------------------

  /** The family's quotas, open shifts and swaps in a club. */
  myDuties(
    context: TenantContext,
    family: Family,
  ): Promise<{
    quotas: {
      groupId: string;
      groupName: string;
      seasonId: string;
      playerId: string;
      shiftsPerPlayer: number;
      done: number;
      planned: number;
    }[];
    openShifts: repo.ShiftRow[];
    shifts: repo.ShiftRow[];
    assignments: repo.AssignmentRow[];
    swaps: repo.SwapRow[];
    visibility: { club: DutyVisibility; groups: Map<string, DutyVisibility> };
    timeZone: string;
  }> {
    const people = [family.me, ...family.wardIds];
    return this.db.withTenant(context, async (tx) => {
      const club = await this.clubs.getClubInTx(tx, context.clubId);
      const now = this.now();
      const today = new Intl.DateTimeFormat("sv-SE", { timeZone: club.timeZone }).format(now);
      const taking = await repo.participations(tx, people);
      const groupIds = [...new Set(taking.map((t) => t.groupId))];
      const quotas: Awaited<ReturnType<DutiesService["myDuties"]>>["quotas"] = [];
      const seasonId = await repo.seasonOn(tx, today);
      if (seasonId) {
        const perGroup = await repo.quotas(tx, groupIds, seasonId);
        for (const [groupId, shiftsPerPlayer] of perGroup) {
          const counts = await repo.quotaCounts(tx, groupId, seasonId, club.timeZone);
          for (const t of taking.filter((x) => x.groupId === groupId)) {
            quotas.push({
              groupId,
              groupName: t.groupName,
              seasonId,
              playerId: t.personId,
              shiftsPerPlayer,
              done: counts.get(t.personId)?.done ?? 0,
              planned: counts.get(t.personId)?.planned ?? 0,
            });
          }
        }
      }
      const range = { from: now, to: new Date(now.getTime() + 60 * 86_400_000) };
      const upcoming = await repo.shifts(tx, { club: true }, range, DUTY_SHIFT_LIST_MAX);
      const groupShifts: repo.ShiftRow[] = [];
      for (const groupId of groupIds) {
        groupShifts.push(...(await repo.shifts(tx, { groupId }, range, 100)));
      }
      const shifts = [...groupShifts, ...upcoming].sort(
        (a, b) => a.startsAt.getTime() - b.startsAt.getTime(),
      );
      const assignments = await repo.assignments(
        tx,
        shifts.map((s) => s.id),
      );
      const filled = (id: string) => assignments.filter((a) => a.shiftId === id).length;
      return {
        quotas,
        openShifts: shifts.filter((s) => filled(s.id) < s.needed),
        shifts,
        assignments,
        swaps: await repo.openSwaps(
          tx,
          shifts.map((s) => s.id),
        ),
        visibility: await this.visibilityInTx(tx, groupIds),
        timeZone: club.timeZone,
      };
    });
  }

  // --- Statistics ----------------------------------------------------------------

  stats(
    context: TenantContext,
    groupId: string,
    seasonId: string,
  ): Promise<{ rows: repo.StatsRow[]; timeZone: string }> {
    return this.db.withTenant(context, async (tx) => {
      if (!(await repo.season(tx, seasonId))) throw new DomainError("duty_season_invalid");
      const club = await this.clubs.getClubInTx(tx, context.clubId);
      return {
        rows: await repo.stats(tx, groupId, seasonId, club.timeZone),
        timeZone: club.timeZone,
      };
    });
  }

  // --- "Mitt schema" and the feeds ------------------------------------------------

  /** The caller's and their wards' shifts in a period, across their clubs. */
  myShifts(
    context: ActorContext,
    range: { from: Date; to: Date },
    limit: number,
  ): Promise<repo.MyDutyRow[]> {
    return this.db.withActor(context, (tx) => repo.myDutyShifts(tx, range, limit));
  }
}

export type { ActorContext };
