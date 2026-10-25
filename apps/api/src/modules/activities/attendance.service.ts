// SPDX-License-Identifier: AGPL-3.0-only
// Responses and attendance (P1.5, ADR 0035). An answer is a member's (or
// guardian's) intent for one activity; attendance is the leaders' record of
// who was there. Both refer to the roster: who was in the activity's groups
// on its start. Writes are idempotent by content (sending the same answer or
// mark again changes nothing and records nothing), so the app's offline
// outbox can resend safely; marks taken offline are ordered by the time on
// the device (the newer mark wins), answers by when they arrive.

import { getCountryPack } from "@clubadmin/country-packs";
import { audit, type Database, outbox, type TenantContext, type Tx } from "@clubadmin/db";
import {
  ATTENDANCE_OPENS_BEFORE_MINUTES,
  type AttendanceRole,
  type AttendanceStatus,
  CALENDAR_MAX_DAYS,
  CLOCK_SKEW_MINUTES,
  type GrantHint,
  localDate,
  OFFLINE_MAX_AGE_DAYS,
  type RecordAttendanceInput,
  RecordAttendanceSchema,
  type ResponseStatus,
  type SetInviteesInput,
  SetInviteesSchema,
  type SetResponseInput,
  SetResponseSchema,
} from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { actorPersonId, parseInput } from "../../platform/domain/run.ts";
import type { ClubsService } from "../clubs/index.ts";
import type { MembershipsService } from "../memberships/index.ts";
import type { PeopleService } from "../people/index.ts";
import * as repo from "./activities.repository.ts";
import * as records from "./attendance.repository.ts";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export type ResponseRow = records.ResponseRow;
export type MarkRow = records.MarkRow;

/** Whether answers are taken now, and whether the deadline has passed. */
export interface AnswerState {
  open: boolean;
  deadlinePassed: boolean;
}

export function answerState(
  activity: {
    status: string;
    responseMode: string;
    endsAt: Date;
    respondBy: Date | null;
  },
  now: Date,
): AnswerState {
  return {
    open:
      activity.status === "scheduled" &&
      activity.responseMode !== "none" &&
      activity.endsAt.getTime() > now.getTime(),
    deadlinePassed: activity.respondBy !== null && now.getTime() > activity.respondBy.getTime(),
  };
}

export interface ResponseSummaryView {
  activity: repo.ActivityRow;
  state: AnswerState;
  counts: { attending: number; notAttending: number; notAnswered: number; roster: number };
  /** People attending (IDs; the caller presents those the viewer may see). */
  attending: string[];
  /** The answers of these people (the viewer's own and wards'), when on the roster. */
  mine: { personId: string; response: ResponseRow | null }[];
}

export interface AttendanceView {
  activity: repo.ActivityRow;
  locked: boolean;
  open: boolean;
  participants: AttendanceEntry[];
  leaders: AttendanceEntry[];
  hints: GrantHint[];
}

export interface AttendanceEntry {
  personId: string;
  role: AttendanceRole;
  mark: MarkRow | null;
  suggested: AttendanceStatus | null;
  guest: boolean;
}

/** What the caller may do with an activity's attendance (decided from the policy's resource). */
export interface AttendanceRights {
  /** Leads one of its groups, or manages the club: records until the lock. */
  leads: boolean;
  /** Club manager or registrar: corrects after the lock, with a reason. */
  corrects: boolean;
}

export interface GroupAttendanceView {
  timeZone: string;
  sessions: {
    session: records.SessionRow;
    recorded: boolean;
    present: number;
    leadersPresent: number;
    hints: GrantHint[];
  }[];
  members: records.MemberSummaryRow[];
  nextCursor: string | null;
}

export interface InviteesView {
  activity: repo.ActivityRow;
  candidates: { personId: string; invited: boolean }[];
  invitedCount: number;
}

const SUGGESTION: Record<ResponseStatus, AttendanceStatus> = {
  attending: "present",
  not_attending: "excused",
};

export class AttendanceService {
  private readonly db: Database;
  private readonly clubs: ClubsService;
  private readonly people: PeopleService;
  private readonly memberships: MembershipsService;
  private readonly now: () => Date;

  constructor(
    db: Database,
    deps: { clubs: ClubsService; people: PeopleService; memberships: MembershipsService },
    now: () => Date = () => new Date(),
  ) {
    this.db = db;
    this.clubs = deps.clubs;
    this.people = deps.people;
    this.memberships = deps.memberships;
    this.now = now;
  }

  // --- Responses -------------------------------------------------------------------

  /**
   * Sets a person's answer (the caller has checked that the actor may answer
   * for them). Until the deadline any answer; after it only "not attending"
   * (illness). Sending the same answer again changes nothing.
   */
  respond(
    context: TenantContext,
    activityId: string,
    personId: string,
    input: SetResponseInput,
  ): Promise<ResponseRow> {
    return this.db.withTenant(onBehalf(context, personId), async (tx) => {
      const data = parseInput(SetResponseSchema, input);
      const activity = await this.answerable(tx, activityId, personId);
      const state = answerState(activity, this.now());
      const [current] = await records.responses(tx, activityId, [personId]);
      const note = data.note ?? null;
      if (current?.status === data.status && current.note === note) return current;
      if (state.deadlinePassed && data.status !== "not_attending") {
        throw new DomainError("response_closed");
      }
      const response = await records.upsertResponse(tx, {
        clubId: context.clubId,
        activityId,
        personId,
        status: data.status,
        note,
        respondedByPersonId: actorPersonId(context),
      });
      await audit.record(tx, {
        action: "activity.response.set",
        resourceType: "activity_response",
        resourceId: response.id,
        changedFields: current
          ? [
              ...(current.status === data.status ? [] : ["status"]),
              ...(current.note === note ? [] : ["note"]),
            ]
          : ["status", ...(note ? ["note"] : [])],
      });
      await outbox.publish(tx, "activity.response.changed", {
        clubId: context.clubId,
        activityId,
        personId,
        change: "set",
      });
      return response;
    });
  }

  /** Withdraws an answer (until the deadline). Withdrawing none changes nothing. */
  withdraw(context: TenantContext, activityId: string, personId: string): Promise<void> {
    return this.db.withTenant(onBehalf(context, personId), async (tx) => {
      const activity = await this.answerable(tx, activityId, personId);
      const [current] = await records.responses(tx, activityId, [personId]);
      if (!current) return;
      if (answerState(activity, this.now()).deadlinePassed) {
        throw new DomainError("response_closed");
      }
      await records.deleteResponse(tx, activityId, personId);
      await audit.record(tx, {
        action: "activity.response.withdrawn",
        resourceType: "activity_response",
        resourceId: current.id,
      });
      await outbox.publish(tx, "activity.response.changed", {
        clubId: context.clubId,
        activityId,
        personId,
        change: "withdrawn",
      });
    });
  }

  /** Counts, who is attending, and the answers of `personIds` (the viewer's family). */
  summary(
    context: TenantContext,
    activityId: string,
    personIds: readonly string[],
  ): Promise<ResponseSummaryView> {
    return this.db.withTenant(context, async (tx) => {
      const activity = await repo.findActivity(tx, activityId);
      if (!activity) throw new DomainError("not_found");
      const roster = (await records.roster(tx, activityId)).filter((r) => r.role === "participant");
      const onRoster = new Set(roster.map((r) => r.personId));
      const answers = (await records.responses(tx, activityId)).filter((r) =>
        onRoster.has(r.personId),
      );
      const byPerson = new Map(answers.map((r) => [r.personId, r]));
      const attending = answers.filter((r) => r.status === "attending").map((r) => r.personId);
      const notAttending = answers.filter((r) => r.status === "not_attending").length;
      return {
        activity,
        state: answerState(activity, this.now()),
        counts: {
          attending: attending.length,
          notAttending,
          notAnswered: roster.length - answers.length,
          roster: roster.length,
        },
        attending,
        mine: personIds
          .filter((id) => onRoster.has(id))
          .map((id) => ({ personId: id, response: byPerson.get(id) ?? null })),
      };
    });
  }

  /** The leaders' list: the roster with every answer (keyset by person). */
  responseList(
    context: TenantContext,
    activityId: string,
    query: {
      status?: ResponseStatus | "none" | undefined;
      cursor?: string | undefined;
      limit: number;
    },
  ): Promise<{
    items: { personId: string; response: ResponseRow | null }[];
    nextCursor: string | null;
    counts: ResponseSummaryView["counts"];
  }> {
    return this.db.withTenant(context, async (tx) => {
      const activity = await repo.findActivity(tx, activityId);
      if (!activity) throw new DomainError("not_found");
      const rows = await records.responseList(tx, activityId, {
        status: query.status ?? null,
        cursor: query.cursor ?? null,
        limit: query.limit + 1,
      });
      const counts = (await records.responseCounts(tx, [activityId])).get(activityId);
      const items = rows.slice(0, query.limit);
      return {
        items: items.map((r) => ({ personId: r.personId, response: r.response })),
        nextCursor: rows.length > query.limit ? items.at(-1)!.personId : null,
        counts: countsOf(counts),
      };
    });
  }

  /** Counts for a page of a calendar (one grouped statement). */
  countsFor(
    context: TenantContext,
    activityIds: readonly string[],
  ): Promise<Map<string, ResponseSummaryView["counts"]>> {
    return this.db.withTenant(context, async (tx) => {
      const rows = await records.responseCounts(tx, activityIds);
      return new Map(activityIds.map((id) => [id, countsOf(rows.get(id))]));
    });
  }

  // --- Attendance -------------------------------------------------------------------

  getAttendance(context: TenantContext, activityId: string): Promise<AttendanceView> {
    return this.db.withTenant(context, async (tx) => {
      const activity = await repo.findActivity(tx, activityId);
      if (!activity) throw new DomainError("not_found");
      return this.attendanceView(tx, activity);
    });
  }

  /**
   * Records marks. Leaders record from an hour before the start until the
   * club's lock; after it club managers and registrars correct, with a
   * reason. Marks older than the one stored (taken offline earlier) are not
   * applied and come back in `stale`; unchanged marks change nothing.
   */
  recordAttendance(
    context: TenantContext,
    activityId: string,
    input: RecordAttendanceInput,
    rights: AttendanceRights,
  ): Promise<{ attendance: AttendanceView; stale: string[] }> {
    return this.db.withTenant(context, async (tx) => {
      const data = parseInput(RecordAttendanceSchema, input);
      const activity = await repo.lockActivity(tx, activityId);
      if (!activity) throw new DomainError("not_found");
      const club = await this.clubs.getClubInTx(tx, context.clubId);
      const now = this.now();
      const { open, locked } = attendanceWindow(activity, club.attendanceLockDays, now);
      if (activity.status === "cancelled") throw new DomainError("activity_cancelled");
      if (!open) throw new DomainError("activity_not_started");
      if (locked ? !rights.corrects : !rights.leads) throw new DomainError("attendance_locked");
      if (locked && !data.correctedReason) throw new DomainError("correction_reason_required");

      const roster = new Map(
        (await records.roster(tx, activityId)).map((r) => [r.personId, r.role]),
      );
      const existing = new Map((await records.marks(tx, activityId)).map((m) => [m.personId, m]));
      const guests = [
        ...new Set(
          data.marks.map((m) => m.personId).filter((id) => !roster.has(id) && !existing.has(id)),
        ),
      ];
      for (const personId of guests) {
        if (!(await this.memberships.isMemberInTx(tx, context.clubId, personId))) {
          throw new DomainError("not_a_club_member");
        }
      }

      const stale: string[] = [];
      const changes: Parameters<typeof records.upsertMarks>[3][number][] = [];
      const corrected: MarkRow[] = [];
      for (const mark of data.marks) {
        // Corrections are made online now; offline marks keep the device's time.
        const recordedAt = locked || !mark.recordedAt ? now : new Date(mark.recordedAt);
        if (
          recordedAt.getTime() > now.getTime() + CLOCK_SKEW_MINUTES * MINUTE_MS ||
          recordedAt.getTime() < now.getTime() - OFFLINE_MAX_AGE_DAYS * DAY_MS
        ) {
          throw new DomainError("recorded_at_out_of_range");
        }
        const current = existing.get(mark.personId);
        const role = roster.get(mark.personId) ?? current?.role ?? mark.role;
        if (current?.status === mark.status && current.role === role) continue;
        if (current && !locked && current.recordedAt.getTime() > recordedAt.getTime()) {
          stale.push(mark.personId);
          continue;
        }
        if (locked && current) corrected.push(current);
        changes.push({
          personId: mark.personId,
          status: mark.status,
          role,
          guest: current?.guest ?? !roster.has(mark.personId),
          recordedByPersonId: actorPersonId(context),
          recordedAt: new Date(Math.min(recordedAt.getTime(), now.getTime())),
          correctedReason: locked ? data.correctedReason! : null,
        });
      }
      await records.upsertMarks(tx, context.clubId, activityId, changes);
      if (changes.length > 0) {
        if (locked) {
          for (const mark of corrected) {
            await audit.record(tx, {
              action: "attendance.corrected",
              resourceType: "attendance_record",
              resourceId: mark.id,
              changedFields: ["status", "corrected_reason"],
            });
          }
          const added = changes.length - corrected.length;
          if (added > 0) {
            await audit.record(tx, {
              action: "attendance.corrected",
              resourceType: "activity",
              resourceId: activityId,
              changedFields: ["status", "corrected_reason"],
            });
          }
        } else {
          await audit.record(tx, {
            action: "attendance.recorded",
            resourceType: "activity",
            resourceId: activityId,
            changedFields: ["status"],
          });
        }
        await outbox.publish(tx, "attendance.recorded", { clubId: context.clubId, activityId });
      }
      return { attendance: await this.attendanceView(tx, activity), stale: [...new Set(stale)] };
    });
  }

  /** A group's attendance over a range: sessions held with their counts, and members (keyset). */
  groupAttendance(
    context: TenantContext,
    groupId: string,
    query: { from: string; to: string; cursor?: string | undefined; limit: number },
  ): Promise<GroupAttendanceView> {
    return this.db.withTenant(context, async (tx) => {
      const from = new Date(query.from);
      const to = new Date(query.to);
      if (to.getTime() <= from.getTime()) throw new DomainError("invalid_input");
      if (to.getTime() - from.getTime() > CALENDAR_MAX_DAYS * DAY_MS) {
        throw new DomainError("range_too_long");
      }
      const club = await this.clubs.getClubInTx(tx, context.clubId);
      const sessions = await records.groupSessions(tx, groupId, { from, to });
      const ids = sessions.map((s) => s.activityId);
      const present = await records.presentIn(tx, context.clubId, ids);
      const recorded = await records.recordedSessions(tx, context.clubId, ids);
      const hints = await this.hintsFor(
        tx,
        club,
        sessions.map((s) => ({ ...s, recorded: recorded.has(s.activityId) })),
        present,
      );
      const rows = await records.memberSummary(
        tx,
        context.clubId,
        groupId,
        { from, to },
        { cursor: query.cursor ?? null, limit: query.limit + 1 },
      );
      const members = rows.slice(0, query.limit);
      return {
        timeZone: club.timeZone,
        sessions: sessions.map((session) => {
          const here = present.filter((p) => p.activityId === session.activityId);
          return {
            session,
            recorded: recorded.has(session.activityId),
            present: here.filter((p) => p.role === "participant").length,
            leadersPresent: here.filter((p) => p.role === "leader").length,
            hints: hints.get(session.activityId) ?? [],
          };
        }),
        members,
        nextCursor: rows.length > query.limit ? members.at(-1)!.personId : null,
      };
    });
  }

  // --- Internals ----------------------------------------------------------------------

  /** The activity locked for an answer from this person: scheduled, asking, not over, on the roster. */
  // --- Call-ups (#19) --------------------------------------------------------------

  /** Who may be called up (the groups' members on the start) and who is. */
  invitees(context: TenantContext, activityId: string): Promise<InviteesView> {
    return this.db.withTenant(context, async (tx) => {
      const activity = await repo.findActivity(tx, activityId);
      if (!activity) throw new DomainError("not_found");
      return this.inviteesView(tx, activity);
    });
  }

  /**
   * Calls up some of the groups' members, or the whole groups again. Those no
   * longer called up keep their answers, which are then not counted. Setting
   * the same again changes nothing.
   */
  setInvitees(
    context: TenantContext,
    activityId: string,
    input: SetInviteesInput,
  ): Promise<InviteesView> {
    return this.db.withTenant(context, async (tx) => {
      const data = parseInput(SetInviteesSchema, input);
      const activity = await repo.lockActivity(tx, activityId);
      if (!activity) throw new DomainError("not_found");
      if (activity.status === "cancelled") throw new DomainError("activity_cancelled");
      if (activity.endsAt.getTime() <= this.now().getTime()) {
        throw new DomainError("activity_ended");
      }
      const candidates = new Set(
        (await records.roster(tx, activityId, { wholeGroups: true }))
          .filter((r) => r.role === "participant")
          .map((r) => r.personId),
      );
      const wanted = new Set(data.personIds);
      if ([...wanted].some((id) => !candidates.has(id))) throw new DomainError("not_on_roster");
      const updated = await this.applyCallUp(tx, context, activity, data.inviteesOnly, wanted);
      return this.inviteesView(tx, updated);
    });
  }

  // --- Events (P1.6, ADR 0038) --------------------------------------------------------

  /** These activities with what linking them to an event needs. */
  async callUpTargetsInTx(
    tx: Tx,
    activityIds: readonly string[],
  ): Promise<
    {
      id: string;
      status: string;
      endsAt: Date;
      inviteesOnly: boolean;
      invitedCount: number;
      groupIds: string[];
    }[]
  > {
    const rows = await repo.findActivities(tx, activityIds);
    const groups = await repo.groupsOfActivities(tx, activityIds);
    const invited = await records.inviteeCounts(tx, activityIds);
    return rows.map((a) => ({
      id: a.id,
      status: a.status,
      endsAt: a.endsAt,
      inviteesOnly: a.inviteesOnly,
      invitedCount: invited.get(a.id) ?? 0,
      groupIds: (groups.get(a.id) ?? []).map((g) => g.id),
    }));
  }

  /**
   * An event's activity: those called up are the event's confirmed
   * participants (no roster check; they may come from the whole club), or,
   * with null, the call-up is lifted. Ended or cancelled activities are left
   * as they are.
   */
  async setCallUpInTx(
    tx: Tx,
    context: TenantContext,
    activityId: string,
    personIds: readonly string[] | null,
    options: { invitedBy?: string } = {},
  ): Promise<void> {
    const activity = await repo.lockActivity(tx, activityId);
    if (!activity || activity.status === "cancelled") return;
    if (activity.endsAt.getTime() <= this.now().getTime()) return;
    await this.applyCallUp(
      tx,
      context,
      activity,
      personIds !== null,
      new Set(personIds ?? []),
      options.invitedBy,
    );
  }

  private async applyCallUp(
    tx: Tx,
    context: TenantContext,
    activity: repo.ActivityRow,
    inviteesOnly: boolean,
    wanted: ReadonlySet<string>,
    invitedBy: string = actorPersonId(context),
  ): Promise<repo.ActivityRow> {
    const activityId = activity.id;
    const current = new Set(await records.invitees(tx, activityId));
    const added = [...wanted].filter((id) => !current.has(id));
    const removed = [...current].filter((id) => !wanted.has(id));
    const modeChanged = activity.inviteesOnly !== inviteesOnly;
    if (!modeChanged && added.length === 0 && removed.length === 0) return activity;
    await records.removeInvitees(tx, activityId, removed);
    await records.addInvitees(tx, {
      clubId: context.clubId,
      activityId,
      personIds: added,
      invitedBy,
    });
    let updated = activity;
    if (modeChanged) {
      // Not a calendar change: neither sequence nor changed_at move (ADR 0036).
      updated = await repo.updateActivity(tx, activityId, { inviteesOnly });
      await repo.syncScheduleEntries(tx, { activityIds: [activityId] });
    }
    await audit.record(tx, {
      action: "activity.invitees.changed",
      resourceType: "activity",
      resourceId: activityId,
      changedFields: [
        ...(modeChanged ? ["invitees_only"] : []),
        ...(added.length > 0 || removed.length > 0 ? ["invitees"] : []),
      ],
    });
    await outbox.publish(tx, "activity.invitees.changed", {
      clubId: context.clubId,
      activityId,
      added,
      removed,
    });
    return updated;
  }

  private async inviteesView(tx: Tx, activity: repo.ActivityRow): Promise<InviteesView> {
    const candidates = (await records.roster(tx, activity.id, { wholeGroups: true }))
      .filter((r) => r.role === "participant")
      .map((r) => r.personId);
    const invited = new Set(await records.invitees(tx, activity.id));
    return {
      activity,
      candidates: candidates.map((personId) => ({ personId, invited: invited.has(personId) })),
      invitedCount: candidates.filter((id) => invited.has(id)).length,
    };
  }

  private async answerable(
    tx: Tx,
    activityId: string,
    personId: string,
  ): Promise<repo.ActivityRow> {
    const activity = await repo.lockActivity(tx, activityId);
    if (!activity) throw new DomainError("not_found");
    if (activity.status === "cancelled") throw new DomainError("activity_cancelled");
    if (activity.responseMode === "none") throw new DomainError("response_not_requested");
    if (activity.endsAt.getTime() <= this.now().getTime()) {
      throw new DomainError("response_closed");
    }
    if (!(await records.onRoster(tx, activityId, [personId])).has(personId)) {
      throw new DomainError("not_on_roster");
    }
    return activity;
  }

  private async attendanceView(tx: Tx, activity: repo.ActivityRow): Promise<AttendanceView> {
    const club = await this.clubs.getClubInTx(tx, activity.clubId);
    const { open, locked } = attendanceWindow(activity, club.attendanceLockDays, this.now());
    const roster = await records.roster(tx, activity.id);
    const marks = new Map((await records.marks(tx, activity.id)).map((m) => [m.personId, m]));
    const answers = new Map(
      (await records.responses(tx, activity.id)).map((r) => [r.personId, r.status]),
    );
    const entries: AttendanceEntry[] = roster.map((r) => {
      const answer = answers.get(r.personId);
      return {
        personId: r.personId,
        role: r.role,
        mark: marks.get(r.personId) ?? null,
        suggested: r.role === "participant" && answer ? SUGGESTION[answer] : null,
        guest: false,
      };
    });
    const onRoster = new Set(roster.map((r) => r.personId));
    for (const mark of marks.values()) {
      if (onRoster.has(mark.personId)) continue;
      entries.push({
        personId: mark.personId,
        role: mark.role,
        mark,
        suggested: null,
        guest: true,
      });
    }
    const present = [...marks.values()]
      .filter((m) => m.status === "present")
      .map((m) => ({ activityId: activity.id, personId: m.personId, role: m.role }));
    const hints = await this.hintsFor(
      tx,
      club,
      [{ ...activity, activityId: activity.id, recorded: marks.size > 0 }],
      present,
    );
    return {
      activity,
      locked,
      open: open && activity.status === "scheduled",
      participants: entries.filter((e) => e.role === "participant"),
      leaders: entries.filter((e) => e.role === "leader"),
      hints: hints.get(activity.id) ?? [],
    };
  }

  /** The country pack's grant rules each recorded session does not meet. */
  private async hintsFor(
    tx: Tx,
    club: { country: string; timeZone: string },
    sessions: readonly { activityId: string; startsAt: Date; endsAt: Date; recorded: boolean }[],
    present: readonly { activityId: string; personId: string; role: AttendanceRole }[],
  ): Promise<Map<string, GrantHint[]>> {
    const rules = getCountryPack(club.country).grantRules;
    const result = new Map<string, GrantHint[]>();
    if (!rules) return result;
    const birthDates = await this.people.birthDatesInTx(
      tx,
      present.map((p) => p.personId),
    );
    for (const s of sessions) {
      if (!s.recorded) continue;
      const here = present.filter((p) => p.activityId === s.activityId);
      const codes = rules.check({
        date: localDate(s.startsAt, club.timeZone),
        durationMinutes: Math.round((s.endsAt.getTime() - s.startsAt.getTime()) / MINUTE_MS),
        participantBirthDates: here
          .filter((p) => p.role === "participant")
          .map((p) => birthDates.get(p.personId) ?? null),
        leaderBirthDates: here
          .filter((p) => p.role === "leader")
          .map((p) => birthDates.get(p.personId) ?? null),
      });
      result.set(
        s.activityId,
        codes.map((code) => ({ scheme: rules.scheme, code })),
      );
    }
    return result;
  }
}

/** When leaders may record: from an hour before the start until the lock (days after the start). */
export function attendanceWindow(
  activity: { startsAt: Date },
  lockDays: number,
  now: Date,
): { open: boolean; locked: boolean } {
  const start = activity.startsAt.getTime();
  return {
    open: now.getTime() >= start - ATTENDANCE_OPENS_BEFORE_MINUTES * MINUTE_MS,
    locked: now.getTime() > start + lockDays * DAY_MS,
  };
}

function countsOf(row: records.ResponseCountRow | undefined): ResponseSummaryView["counts"] {
  if (!row) return { attending: 0, notAttending: 0, notAnswered: 0, roster: 0 };
  return {
    attending: row.attending,
    notAttending: row.notAttending,
    notAnswered: row.roster - row.attending - row.notAttending,
    roster: row.roster,
  };
}

/** A guardian answering for a ward is recorded as acting on their behalf (ADR 0006). */
function onBehalf(context: TenantContext, personId: string): TenantContext {
  if (context.onBehalfOf || context.personId === personId) return context;
  return { ...context, onBehalfOf: personId };
}
