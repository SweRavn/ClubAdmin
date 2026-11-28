// SPDX-License-Identifier: AGPL-3.0-only
// Responses and attendance (P1.5, ADR 0035). An answer is a member's (or
// guardian's) intent for one activity; attendance is the leaders' record of
// who was there. Both refer to the roster: who was in the activity's groups
// on its start. Writes are idempotent by content (sending the same answer or
// mark again changes nothing and records nothing), so the app's offline
// outbox can resend safely; marks taken offline are ordered by the time on
// the device (the newer mark wins), answers by when they arrive.

import { audit, type Database, outbox, type TenantContext, type Tx } from "@clubadmin/db";
import {
  ATTENDANCE_OPENS_BEFORE_MINUTES,
  type AttendanceRole,
  type AttendanceStatus,
  CALENDAR_MAX_DAYS,
  CLOCK_SKEW_MINUTES,
  type GrantHint,
  OFFLINE_MAX_AGE_DAYS,
  type RecordAttendanceInput,
  RecordAttendanceSchema,
  type ResponseStatus,
  type SetInviteeInput,
  SetInviteeSchema,
  type SetInviteesInput,
  SetInviteesSchema,
  type SetResponseInput,
  SetResponseSchema,
  type SetSeriesInviteesInput,
  SetSeriesInviteesSchema,
} from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { actorPersonId, parseInput } from "../../platform/domain/run.ts";
import type { ClubsService } from "../clubs/index.ts";
import type { HintInput } from "../grants/index.ts";
import type { MembershipsService } from "../memberships/index.ts";
import type { PeopleService } from "../people/index.ts";
import * as repo from "./activities.repository.ts";
import * as records from "./attendance.repository.ts";
import {
  applyCallUpInTx,
  applyCallUpsInTx,
  callUpAnnounced,
  type CallUpChange,
  callUpSentAt,
} from "./call-ups.ts";

const MINUTE_MS = 60_000;

/** The grant plugins' hints per session (P2.7: GrantsService.sessionHints). */
export type GrantHintsProvider = (
  context: TenantContext,
  inputs: readonly HintInput[],
) => Promise<Map<string, GrantHint[]>>;
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
  counts: {
    attending: number;
    notAttending: number;
    notAnswered: number;
    roster: number;
    /** The roster's leaders, who answer too (P2.7b); summaries only. */
    leaders?: { attending: number; notAttending: number; notAnswered: number; roster: number };
  };
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
  candidates: {
    personId: string;
    invited: boolean;
    guest: boolean;
    groups: { id: string; name: string }[];
  }[];
  invitedCount: number;
  /** Found by name (`q`): active members not on the list. */
  others: { personId: string; groups: { id: string; name: string }[] }[];
  callUpSentAt: Date | null;
  announced: boolean;
  editable: boolean;
  /** A series session following its series' call-up. */
  seriesId: string | null;
  revocations: records.RevocationRow[];
}

export interface SeriesInviteesView {
  seriesId: string;
  inviteesOnly: boolean;
  people: { personId: string; inSeries: boolean; guest: boolean }[];
  sessions: {
    activity: repo.ActivityRow;
    callUpSentAt: Date | null;
    calledUp: Set<string>;
    overrides: Map<string, records.OverrideKind>;
  }[];
  nextCursor: string | null;
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
  private readonly grantHints: GrantHintsProvider | undefined;
  private readonly now: () => Date;

  constructor(
    db: Database,
    deps: {
      clubs: ClubsService;
      people: PeopleService;
      memberships: MembershipsService;
      /** The club's enabled grant plugins' hints (P2.7); none without. */
      grantHints?: GrantHintsProvider;
    },
    now: () => Date = () => new Date(),
  ) {
    this.db = db;
    this.clubs = deps.clubs;
    this.people = deps.people;
    this.memberships = deps.memberships;
    this.grantHints = deps.grantHints;
    this.now = now;
  }

  // --- Responses -------------------------------------------------------------------

  /**
   * Sets a person's answer (the caller has checked that the actor may answer
   * for them). Until the deadline any answer; after it only "not attending"
   * (illness). A leader of the activity's groups answers for a participant
   * at any time (`byLeader`, P1.6b). Without a note the current note stays.
   * Sending the same answer again changes nothing.
   */
  respond(
    context: TenantContext,
    activityId: string,
    personId: string,
    input: SetResponseInput,
    /** `via`: answered from a calendar's answer link (P1.11; audited with it). */
    options: { byLeader?: boolean; via?: "calendar_link" } = {},
  ): Promise<ResponseRow> {
    const txContext = options.byLeader ? context : onBehalf(context, personId);
    return this.db.withTenant(txContext, async (tx) => {
      const data = parseInput(SetResponseSchema, input);
      const activity = await this.answerable(tx, activityId, personId);
      const state = answerState(activity, this.now());
      const [current] = await records.responses(tx, activityId, [personId]);
      const note = data.note === undefined ? (current?.note ?? null) : data.note;
      if (current?.status === data.status && current.note === note) return current;
      if (!options.byLeader && state.deadlinePassed && data.status !== "not_attending") {
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
        action: options.byLeader ? "activity.response.set_by_leader" : "activity.response.set",
        resourceType: "activity_response",
        resourceId: response.id,
        changedFields: current
          ? [
              ...(current.status === data.status ? [] : ["status"]),
              ...(current.note === note ? [] : ["note"]),
            ]
          : ["status", ...(note ? ["note"] : [])],
      });
      if (options.via) {
        await audit.record(tx, {
          action: "activity.response.set",
          resourceType: "activity_response",
          resourceId: response.id,
          changedFields: ["via_calendar_link"],
        });
      }
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
      const everyone = await records.roster(tx, activityId);
      const roster = everyone.filter((r) => r.role === "participant");
      const leaders = new Set(everyone.filter((r) => r.role === "leader").map((r) => r.personId));
      const onRoster = new Set(roster.map((r) => r.personId));
      const all = await records.responses(tx, activityId);
      const answers = all.filter((r) => onRoster.has(r.personId));
      const leaderAnswers = all.filter((r) => leaders.has(r.personId));
      const byPerson = new Map(all.map((r) => [r.personId, r]));
      const attending = answers.filter((r) => r.status === "attending").map((r) => r.personId);
      const notAttending = answers.filter((r) => r.status === "not_attending").length;
      const leadersAttending = leaderAnswers.filter((r) => r.status === "attending").length;
      const leadersNotAttending = leaderAnswers.filter((r) => r.status === "not_attending").length;
      return {
        activity,
        state: answerState(activity, this.now()),
        // Participants as before; leaders answer too and are counted apart (P2.7b).
        counts: {
          attending: attending.length,
          notAttending,
          notAnswered: roster.length - answers.length,
          roster: roster.length,
          leaders: {
            attending: leadersAttending,
            notAttending: leadersNotAttending,
            notAnswered: leaders.size - leaderAnswers.length,
            roster: leaders.size,
          },
        },
        attending,
        mine: personIds
          .filter((id) => onRoster.has(id) || leaders.has(id))
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
    items: { personId: string; role: "participant" | "leader"; response: ResponseRow | null }[];
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
        items: items.map((r) => ({ personId: r.personId, role: r.role, response: r.response })),
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

  async getAttendance(context: TenantContext, activityId: string): Promise<AttendanceView> {
    const { view, inputs } = await this.db.withTenant(context, async (tx) => {
      const activity = await repo.findActivity(tx, activityId);
      if (!activity) throw new DomainError("not_found");
      return this.attendanceView(tx, activity);
    });
    return this.withHints(context, view, inputs);
  }

  /** The grant plugins' hints, asked after the transaction (a plugin call never holds one). */
  private async hints(
    context: TenantContext,
    inputs: readonly HintInput[],
  ): Promise<Map<string, GrantHint[]>> {
    if (!this.grantHints || inputs.length === 0) return new Map();
    return this.grantHints(context, inputs);
  }

  private async withHints(
    context: TenantContext,
    view: AttendanceView,
    inputs: readonly HintInput[],
  ): Promise<AttendanceView> {
    const hints = await this.hints(context, inputs);
    return { ...view, hints: hints.get(view.activity.id) ?? [] };
  }

  /**
   * Records marks. Leaders record from an hour before the start until the
   * club's lock; after it club managers and registrars correct, with a
   * reason. Marks older than the one stored (taken offline earlier) are not
   * applied and come back in `stale`; unchanged marks change nothing.
   */
  async recordAttendance(
    context: TenantContext,
    activityId: string,
    input: RecordAttendanceInput,
    rights: AttendanceRights,
  ): Promise<{ attendance: AttendanceView; stale: string[] }> {
    const result = await this.db.withTenant(context, async (tx) => {
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
      const { view, inputs } = await this.attendanceView(tx, activity);
      return { view, inputs, stale: [...new Set(stale)] };
    });
    return {
      attendance: await this.withHints(context, result.view, result.inputs),
      stale: result.stale,
    };
  }

  /** A group's attendance over a range: sessions held with their counts, and members (keyset). */
  async groupAttendance(
    context: TenantContext,
    groupId: string,
    query: { from: string; to: string; cursor?: string | undefined; limit: number },
  ): Promise<GroupAttendanceView> {
    const view = await this.db.withTenant(context, async (tx) => {
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
      const inputs = hintInputs(
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
            hints: [] as GrantHint[],
          };
        }),
        members,
        nextCursor: rows.length > query.limit ? members.at(-1)!.personId : null,
        inputs,
      };
    });
    const hints = await this.hints(context, view.inputs);
    const { inputs: _inputs, ...rest } = view;
    return {
      ...rest,
      sessions: rest.sessions.map((s) => ({ ...s, hints: hints.get(s.session.activityId) ?? [] })),
    };
  }

  // --- Internals ----------------------------------------------------------------------

  /** The activity locked for an answer from this person: scheduled, asking, not over, on the roster. */
  // --- Call-ups (#19, P2.10, ADR 0056) ------------------------------------------------

  /**
   * Who may be called up (the groups' participants, guests marked, and those
   * called up from elsewhere), who is, when the call-up went out, its
   * revocations; with `q` also active members of the club found by name.
   */
  invitees(
    context: TenantContext,
    activityId: string,
    query: { q?: string | undefined } = {},
  ): Promise<InviteesView> {
    return this.db.withTenant(context, async (tx) => {
      const activity = await repo.findActivity(tx, activityId);
      if (!activity) throw new DomainError("not_found");
      return this.inviteesView(tx, activity, query.q ?? null);
    });
  }

  /**
   * Calls up people (any active member of the club, never the groups'
   * leaders), or the whole groups again. Until the start; not an event's
   * session. After the call-up went out, removals are revocations and need a
   * reason. A series session following its series' call-up keeps the
   * difference as its own overrides.
   */
  setInvitees(
    context: TenantContext,
    activityId: string,
    input: SetInviteesInput,
  ): Promise<InviteesView> {
    return this.db.withTenant(context, async (tx) => {
      const data = parseInput(SetInviteesSchema, input);
      const activity = await this.callUpTarget(tx, activityId);
      const wanted = new Set(data.personIds);
      await this.requireCallable(tx, context.clubId, activity, wanted);
      const series = await this.followedSeries(tx, activity);
      if (series && data.inviteesOnly) {
        const listed = await records.seriesInvitees(tx, series.id);
        const by = actorPersonId(context);
        for (const personId of new Set([...listed, ...wanted])) {
          const kind =
            wanted.has(personId) === listed.has(personId)
              ? null
              : wanted.has(personId)
                ? "added"
                : "removed";
          await records.setOverride(tx, context.clubId, activity.id, personId, kind, by);
        }
      }
      await applyCallUpInTx(
        tx,
        context,
        activity,
        data.inviteesOnly,
        wanted,
        actorPersonId(context),
        {
          now: this.now(),
          reason: data.revocationReason ?? null,
        },
      );
      return this.inviteesView(tx, (await repo.findActivity(tx, activityId))!, null);
    });
  }

  /** One person on one activity (a series session: an override of its series' list). */
  setInvitee(
    context: TenantContext,
    activityId: string,
    personId: string,
    input: SetInviteeInput,
  ): Promise<InviteesView> {
    return this.db.withTenant(context, async (tx) => {
      const data = parseInput(SetInviteeSchema, input);
      const activity = await this.callUpTarget(tx, activityId);
      const current = (await records.inviteesOf(tx, [activity.id])).get(activity.id)!;
      const groups = (await records.groupParticipantsOf(tx, [activity.id])).get(activity.id)!;
      const effective = new Set(activity.inviteesOnly ? current : groups);
      if (data.calledUp) effective.add(personId);
      else effective.delete(personId);
      await this.requireCallable(tx, context.clubId, activity, effective);
      const series = await this.followedSeries(tx, activity);
      if (series) {
        const listed = await records.seriesInvitees(tx, series.id);
        const kind =
          data.calledUp === listed.has(personId) ? null : data.calledUp ? "added" : "removed";
        await records.setOverride(
          tx,
          context.clubId,
          activity.id,
          personId,
          kind,
          actorPersonId(context),
        );
      }
      await applyCallUpInTx(tx, context, activity, true, effective, actorPersonId(context), {
        now: this.now(),
        reason: data.revocationReason ?? null,
      });
      return this.inviteesView(tx, (await repo.findActivity(tx, activityId))!, null);
    });
  }

  /**
   * A series' call-up and the grid of its coming sessions (a page by start):
   * the groups' participants and the series' guests by session.
   */
  seriesInvitees(
    context: TenantContext,
    seriesId: string,
    page: { cursor?: string | undefined; limit: number },
  ): Promise<SeriesInviteesView> {
    return this.db.withTenant(context, async (tx) => {
      const series = await repo.findSeries(tx, seriesId);
      if (!series) throw new DomainError("not_found");
      const now = this.now();
      const rows = await repo.seriesComingSessions(tx, seriesId, now, {
        cursor: page.cursor ?? null,
        limit: page.limit + 1,
      });
      const sessions = rows.slice(0, page.limit);
      const ids = sessions.map((a) => a.id);
      const listed = await records.seriesInvitees(tx, seriesId);
      const group = await repo.seriesGroupPeople(tx, seriesId);
      const invited = await records.inviteesOf(tx, ids);
      const overrides = await records.overridesOf(tx, ids);
      const extra = new Set([...listed, ...[...invited.values()].flatMap((s) => [...s])]);
      const people = [...new Set([...group.participants, ...extra])];
      return {
        seriesId,
        inviteesOnly: series.inviteesOnly,
        people: people.map((personId) => ({
          personId,
          inSeries: listed.has(personId),
          guest: group.guests.has(personId) || !group.participants.has(personId),
        })),
        sessions: sessions.map((activity) => ({
          activity,
          callUpSentAt: callUpSentAt(activity, now),
          calledUp: activity.inviteesOnly
            ? (invited.get(activity.id) ?? new Set())
            : new Set(group.participants),
          overrides: overrides.get(activity.id) ?? new Map(),
        })),
        nextCursor: rows.length > page.limit ? sessions.at(-1)!.id : null,
      };
    });
  }

  /**
   * Sets a series' call-up: every coming session that follows the series
   * (not detached, not an event's) gets the list with its own overrides, in
   * one go; removals from sessions whose call-up went out are revocations
   * with one reason and one notice per person (ADR 0056 decision 6).
   */
  setSeriesInvitees(
    context: TenantContext,
    seriesId: string,
    input: SetSeriesInviteesInput,
  ): Promise<{ sessions: number; revoked: number }> {
    return this.db.withTenant(context, async (tx) => {
      const data = parseInput(SetSeriesInviteesSchema, input);
      const series = await repo.lockSeries(tx, seriesId);
      if (!series) throw new DomainError("not_found");
      const group = await repo.seriesGroupPeople(tx, seriesId);
      const wanted = new Set(data.personIds);
      const outside = [...wanted].filter((id) => !group.participants.has(id));
      if ([...wanted].some((id) => group.leaders.has(id) && !group.participants.has(id))) {
        throw new DomainError("not_callable");
      }
      const active = await this.memberships.activeMembersInTx(tx, context.clubId, outside);
      if (outside.some((id) => !active.has(id))) throw new DomainError("not_callable");
      const by = actorPersonId(context);
      await repo.updateSeries(tx, seriesId, { inviteesOnly: data.inviteesOnly });
      await records.replaceSeriesInvitees(
        tx,
        context.clubId,
        seriesId,
        data.inviteesOnly ? [...wanted] : [],
        by,
      );
      const now = this.now();
      const coming = (await repo.seriesComingSessions(tx, seriesId, now, null)).filter(
        (a) => !a.detached && a.status === "scheduled",
      );
      const events = await records.eventSessions(
        tx,
        coming.map((a) => a.id),
      );
      const sessions = coming.filter((a) => !events.has(a.id));
      const overrides = await records.overridesOf(
        tx,
        sessions.map((a) => a.id),
      );
      if (!data.inviteesOnly) {
        await records.deleteOverrides(
          tx,
          sessions.map((a) => a.id),
        );
      }
      const changes: CallUpChange[] = sessions.map((activity) => {
        const own = overrides.get(activity.id) ?? new Map<string, records.OverrideKind>();
        const effective = new Set(wanted);
        for (const [personId, kind] of own) {
          if (kind === "added") effective.add(personId);
          else effective.delete(personId);
        }
        return data.inviteesOnly
          ? { activity, inviteesOnly: true, wanted: effective }
          : { activity, inviteesOnly: false, wanted: new Set<string>() };
      });
      const result = await applyCallUpsInTx(tx, context, changes, {
        invitedBy: by,
        now,
        reason: data.revocationReason ?? null,
        seriesId,
      });
      await audit.record(tx, {
        action: "activity.series.invitees.changed",
        resourceType: "activity_series",
        resourceId: seriesId,
        changedFields: ["invitees"],
      });
      return {
        sessions: changes.length,
        revoked: [...result.revoked.values()].reduce((n, ids) => n + ids.length, 0),
      };
    });
  }

  /** An activity whose call-up may change now: scheduled, not started, not an event's. */
  private async callUpTarget(tx: Tx, activityId: string): Promise<repo.ActivityRow> {
    const activity = await repo.lockActivity(tx, activityId);
    if (!activity) throw new DomainError("not_found");
    if (activity.status === "cancelled") throw new DomainError("activity_cancelled");
    if (activity.startsAt.getTime() <= this.now().getTime()) {
      throw new DomainError("activity_started");
    }
    if ((await records.eventSessions(tx, [activity.id])).size > 0) {
      throw new DomainError("event_session");
    }
    return activity;
  }

  /** The series whose call-up the session follows (not detached), if any. */
  private async followedSeries(tx: Tx, activity: repo.ActivityRow): Promise<repo.SeriesRow | null> {
    if (!activity.seriesId || activity.detached) return null;
    const series = await repo.findSeries(tx, activity.seriesId);
    return series?.inviteesOnly ? series : null;
  }

  /** Those called up from outside the groups are active members, never the groups' leaders. */
  private async requireCallable(
    tx: Tx,
    clubId: string,
    activity: repo.ActivityRow,
    wanted: ReadonlySet<string>,
  ): Promise<void> {
    const groups = (await records.groupParticipantsOf(tx, [activity.id])).get(activity.id)!;
    const current = (await records.inviteesOf(tx, [activity.id])).get(activity.id)!;
    const leaders = await records.groupLeadersOf(tx, activity.id);
    if ([...wanted].some((id) => leaders.has(id) && !groups.has(id))) {
      throw new DomainError("not_callable");
    }
    const outside = [...wanted].filter((id) => !groups.has(id) && !current.has(id));
    const active = await this.memberships.activeMembersInTx(tx, clubId, outside);
    if (outside.some((id) => !active.has(id))) throw new DomainError("not_callable");
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

  private applyCallUp(
    tx: Tx,
    context: TenantContext,
    activity: repo.ActivityRow,
    inviteesOnly: boolean,
    wanted: ReadonlySet<string>,
    invitedBy: string = actorPersonId(context),
  ): Promise<repo.ActivityRow> {
    return applyCallUpInTx(tx, context, activity, inviteesOnly, wanted, invitedBy, {
      now: this.now(),
    });
  }

  private async inviteesView(
    tx: Tx,
    activity: repo.ActivityRow,
    q: string | null,
  ): Promise<InviteesView> {
    const roster = (await records.roster(tx, activity.id, { wholeGroups: true })).filter(
      (r) => r.role === "participant",
    );
    const invited = new Set(await records.invitees(tx, activity.id));
    // Members first, then guests (ADR 0056: "Gäster" apart).
    const ordered = [...roster.filter((r) => !r.guest), ...roster.filter((r) => r.guest)];
    const onList = new Set(ordered.map((r) => r.personId));
    const leaders = await records.groupLeadersOf(tx, activity.id);
    const found = q
      ? (await this.memberships.activeMembersMatchingInTx(tx, activity.clubId, q, 25)).filter(
          (id) => !onList.has(id) && !leaders.has(id),
        )
      : [];
    const groups = await repo.groupsOfPeople(tx, activity.clubId, [
      ...ordered.filter((r) => r.guest).map((r) => r.personId),
      ...found,
    ]);
    const now = this.now();
    const series = await this.followedSeries(tx, activity);
    return {
      activity,
      candidates: ordered.map((r) => ({
        personId: r.personId,
        invited: invited.has(r.personId),
        guest: r.guest,
        groups: groups.get(r.personId) ?? [],
      })),
      invitedCount: ordered.filter((r) => invited.has(r.personId)).length,
      others: found.map((personId) => ({ personId, groups: groups.get(personId) ?? [] })),
      callUpSentAt: callUpSentAt(activity, now),
      announced: callUpAnnounced(activity, now),
      editable:
        activity.status === "scheduled" &&
        activity.startsAt.getTime() > now.getTime() &&
        (await records.eventSessions(tx, [activity.id])).size === 0,
      seriesId: series?.id ?? null,
      revocations: await records.revocations(tx, [activity.id]),
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

  private async attendanceView(
    tx: Tx,
    activity: repo.ActivityRow,
  ): Promise<{ view: AttendanceView; inputs: HintInput[] }> {
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
        // Leaders answer too (P2.7b): their answer pre-fills their mark as well.
        suggested: answer ? SUGGESTION[answer] : null,
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
    const inputs = hintInputs(
      [{ ...activity, activityId: activity.id, recorded: marks.size > 0 }],
      present,
    );
    return {
      view: {
        activity,
        locked,
        open: open && activity.status === "scheduled",
        participants: entries.filter((e) => e.role === "participant"),
        leaders: entries.filter((e) => e.role === "leader"),
        hints: [],
      },
      inputs,
    };
  }
}

/** The recorded sessions as the grant plugins' hints need them (who was present). */
function hintInputs(
  sessions: readonly { activityId: string; startsAt: Date; endsAt: Date; recorded: boolean }[],
  present: readonly { activityId: string; personId: string; role: AttendanceRole }[],
): HintInput[] {
  return sessions
    .filter((s) => s.recorded)
    .map((s) => {
      const here = present.filter((p) => p.activityId === s.activityId);
      return {
        activityId: s.activityId,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        participantIds: here.filter((p) => p.role === "participant").map((p) => p.personId),
        leaderIds: here.filter((p) => p.role === "leader").map((p) => p.personId),
      };
    });
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
