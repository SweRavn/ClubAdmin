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
  type TenantContext,
  type Tx,
} from "@clubadmin/db";
import {
  type AssignDutyInput,
  AssignDutySchema,
  type CreateDutyShiftInput,
  CreateDutyShiftSchema,
  type CreateDutyTypeInput,
  CreateDutyTypeSchema,
  DUTY_SHIFT_LIST_MAX,
  type DutySignUpInput,
  DutySignUpSchema,
  type PutDutyQuotaInput,
  PutDutyQuotaSchema,
  type PutDutySettingsInput,
  PutDutySettingsSchema,
  type UpdateDutyShiftInput,
  UpdateDutyShiftSchema,
  type UpdateDutyTypeInput,
  UpdateDutyTypeSchema,
} from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { actorPersonId, parseInput } from "../../platform/domain/run.ts";
import type { ClubsService } from "../clubs/index.ts";
import * as repo from "./duties.repository.ts";

export type { AssignmentRow, DutySettingsRow, DutyTypeRow, ShiftRow } from "./duties.repository.ts";

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
  private readonly now: () => Date;

  constructor(db: Database, deps: { clubs: ClubsService; now?: () => Date }) {
    this.db = db;
    this.clubs = deps.clubs;
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

  // --- Who may do it and whom it counts for --------------------------------------

  private async requireAge(tx: Tx, shift: repo.ShiftRow, personId: string): Promise<void> {
    if (shift.minAge === null) return;
    const facts = (await repo.ages(tx, [personId])).get(personId);
    const on = shift.startsAt;
    const tooYoung = facts?.birthDate
      ? ageOn(facts.birthDate, on) < shift.minAge
      : facts?.hasGuardian === true;
    if (tooYoung) throw new DomainError("duty_too_young");
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
      await this.requireAge(tx, shift, worker);
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
      await this.requireAge(tx, shift, data.personId);
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
}

export type { ActorContext };
