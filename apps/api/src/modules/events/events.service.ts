// SPDX-License-Identifier: AGPL-3.0-only
// Events with sign-up (P1.6, ADR 0038). An event is a sign-up container for
// some groups or the whole club: a form of questions, deadlines, a capacity
// and a waiting list. Every change to an event's places happens with the
// event row locked, so places are never given twice; when a place frees up
// the next one in the queue is confirmed (`auto`) or offered (`offer`) in
// the same transaction. The event's activities are called up (ADR 0036) to
// exactly the confirmed participants. Answers to sensitive questions are
// sealed; their values never reach audit events, logs or domain events.

import { audit, type Database, outbox, type TenantContext, type Tx } from "@clubadmin/db";
import {
  type Answers,
  answersSchemaFor,
  type CreateEventInput,
  CreateEventSchema,
  DEFAULT_OFFER_REPLY_HOURS,
  type EventCounts,
  type EventListQuery,
  type EventQuestion,
  EventQuestionsSchema,
  type RegisterInput,
  RegisterSchema,
  type RegistrationListQuery,
  type RegistrationStatus,
  SetEventActivitiesSchema,
  splitAnswers,
  type UpdateEventInput,
  UpdateEventSchema,
  uuidv7,
  type WaitlistMode,
} from "@clubadmin/shared";

import type { FieldEncryption } from "../../platform/crypto/field-encryption.ts";
import { DomainError } from "../../platform/domain/domain-error.ts";
import { actorPersonId, definedOnly, parseInput } from "../../platform/domain/run.ts";
import type { ActivitiesService, AttendanceService, Location } from "../activities/index.ts";
import type { ClubsService } from "../clubs/index.ts";
import * as repo from "./events.repository.ts";

const HOUR_MS = 3_600_000;

export type EventRow = repo.EventRow;
export type RegistrationRow = repo.RegistrationRow;
export type EventScope = repo.EventScope;

export interface EventView {
  event: repo.EventRow;
  timeZone: string;
  groups: { id: string; name: string }[];
  location: Location | null;
  counts: EventCounts;
  /** Sign-up is open now. */
  open: boolean;
  activities: {
    id: string;
    kind: string;
    title: string;
    status: string;
    startsAt: Date;
    endsAt: Date;
  }[];
}

export interface RegistrationView {
  registration: repo.RegistrationRow;
  /** Place in the queue (1 = next) while waiting. */
  position: number | null;
  /** Unsealed only when asked for (organisers, guardians with see_medical). */
  sensitiveAnswers: Answers | null;
}

/** What happened to the place of a registration (for the caller's response). */
export interface RegistrationResult {
  view: EventView;
  registration: RegistrationView;
}

interface Deps {
  clubs: ClubsService;
  activities: ActivitiesService;
  attendance: AttendanceService;
  encryption: FieldEncryption;
}

const sensitiveAad = (registrationId: string) => `event_registration.sensitive:${registrationId}`;

/** Empty answers (blank text, no choices) count as not given. */
function withoutEmpty(answers: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(answers).filter(
      ([, v]) =>
        v !== null &&
        v !== undefined &&
        !(typeof v === "string" && v.trim() === "") &&
        !(Array.isArray(v) && v.length === 0),
    ),
  );
}

/** Answers validated against the questions (answer_required / answer_invalid). */
export function validAnswers(
  questions: readonly EventQuestion[],
  raw: Record<string, unknown>,
): Answers {
  const answers = withoutEmpty(raw);
  const result = answersSchemaFor(questions).safeParse(answers);
  if (result.success) return result.data;
  if (questions.some((q) => q.required && !(q.id in answers))) {
    throw new DomainError("answer_required");
  }
  throw new DomainError("answer_invalid");
}

export function isOpen(event: repo.EventRow, now: Date): boolean {
  return (
    event.status === "published" &&
    (event.registrationOpensAt === null || event.registrationOpensAt <= now) &&
    now <= event.registrationClosesAt
  );
}

export class EventsService {
  private readonly db: Database;
  private readonly deps: Deps;
  private readonly now: () => Date;

  constructor(db: Database, deps: Deps, now: () => Date = () => new Date()) {
    this.db = db;
    this.deps = deps;
    this.now = now;
  }

  // --- Events --------------------------------------------------------------------------

  /**
   * A draft (or, with `publish`, a published event) for these groups or the
   * whole club, with its new activities in all audience groups. The caller
   * has checked that the actor manages each audience group (or may create
   * club events).
   */
  createEvent(context: TenantContext, input: CreateEventInput): Promise<EventView> {
    return this.db.withTenant(context, async (tx) => {
      const data = parseInput(CreateEventSchema, input);
      const groupIds = [...new Set(data.groupIds)];
      if (data.audience === "club" && data.activities.length > 0) {
        // Activities belong to groups: a club event links existing ones.
        throw new DomainError("invalid_input");
      }
      await this.deps.activities.requireGroupsInTx(tx, context.clubId, groupIds);
      const locationId = data.locationId ?? null;
      if (locationId) await this.requireLocation(tx, context.clubId, locationId);
      this.checkDeadlines({
        startsAt: new Date(data.startsAt),
        registrationOpensAt: data.registrationOpensAt ? new Date(data.registrationOpensAt) : null,
        registrationClosesAt: new Date(data.registrationClosesAt),
      });
      const waitlistMode: WaitlistMode =
        data.waitlistMode ?? (data.audience === "club" ? "auto" : "offer");
      const event = await repo.insertEvent(tx, {
        id: uuidv7(),
        clubId: context.clubId,
        title: data.title,
        description: data.description ?? null,
        audience: data.audience,
        status: data.publish ? "published" : "draft",
        startsAt: new Date(data.startsAt),
        endsAt: new Date(data.endsAt),
        locationId,
        locationText: locationId ? null : (data.locationText ?? null),
        priceText: data.priceText ?? null,
        registrationOpensAt: data.registrationOpensAt ? new Date(data.registrationOpensAt) : null,
        registrationClosesAt: new Date(data.registrationClosesAt),
        cancellationClosesAt: data.cancellationClosesAt
          ? new Date(data.cancellationClosesAt)
          : null,
        capacity: data.capacity ?? null,
        waitlistMode,
        offerReplyHours: data.offerReplyHours ?? DEFAULT_OFFER_REPLY_HOURS,
        questions: data.questions ?? [],
        createdByPersonId: actorPersonId(context),
      });
      await repo.insertEventGroups(tx, context.clubId, event.id, groupIds);
      const activityIds: string[] = [];
      for (const a of data.activities) {
        const view = await this.deps.activities.createActivityInTx(tx, context, groupIds[0]!, {
          kind: a.kind,
          title: a.title,
          startsAt: a.startsAt,
          endsAt: a.endsAt,
          locationId: a.locationId ?? null,
          locationText: a.locationText ?? null,
          groupIds: groupIds.slice(1),
        });
        activityIds.push(view.activity.id);
      }
      await repo.addEventActivities(tx, context.clubId, event.id, activityIds);
      // Nobody is confirmed yet: the activities are called up to no one.
      for (const id of activityIds) {
        await this.deps.attendance.setCallUpInTx(tx, context, id, []);
      }
      await audit.record(tx, {
        action: "event.created",
        resourceType: "event",
        resourceId: event.id,
      });
      if (data.publish) {
        await audit.record(tx, {
          action: "event.published",
          resourceType: "event",
          resourceId: event.id,
        });
      }
      await this.publishChange(tx, event, data.publish ? "published" : "created");
      return (await this.views(tx, context.clubId, [event]))[0]!;
    });
  }

  getEvent(context: TenantContext, eventId: string): Promise<EventView> {
    return this.db.withTenant(context, async (tx) => {
      const event = await repo.findEvent(tx, eventId);
      if (!event) throw new DomainError("not_found");
      return (await this.views(tx, context.clubId, [event]))[0]!;
    });
  }

  /**
   * Changes the event. The capacity cannot go below the confirmed count
   * (raising it moves the queue up); questions somebody has answered keep
   * their ID and type.
   */
  updateEvent(
    context: TenantContext,
    eventId: string,
    input: UpdateEventInput,
  ): Promise<EventView> {
    return this.db.withTenant(context, async (tx) => {
      const data = definedOnly(parseInput(UpdateEventSchema, input));
      const current = await repo.lockEvent(tx, eventId);
      if (!current) throw new DomainError("not_found");
      if (current.status === "cancelled") throw new DomainError("event_cancelled");
      const next: Partial<repo.NewEventRow> = {
        ...(data.title === undefined ? {} : { title: data.title }),
        ...("description" in data ? { description: data.description ?? null } : {}),
        ...(data.startsAt === undefined ? {} : { startsAt: new Date(data.startsAt) }),
        ...(data.endsAt === undefined ? {} : { endsAt: new Date(data.endsAt) }),
        ...("priceText" in data ? { priceText: data.priceText ?? null } : {}),
        ...("registrationOpensAt" in data
          ? {
              registrationOpensAt: data.registrationOpensAt
                ? new Date(data.registrationOpensAt)
                : null,
            }
          : {}),
        ...(data.registrationClosesAt === undefined
          ? {}
          : { registrationClosesAt: new Date(data.registrationClosesAt) }),
        ...("cancellationClosesAt" in data
          ? {
              cancellationClosesAt: data.cancellationClosesAt
                ? new Date(data.cancellationClosesAt)
                : null,
            }
          : {}),
        ...("capacity" in data ? { capacity: data.capacity ?? null } : {}),
        ...(data.waitlistMode === undefined ? {} : { waitlistMode: data.waitlistMode }),
        ...(data.offerReplyHours === undefined ? {} : { offerReplyHours: data.offerReplyHours }),
      };
      if ("locationId" in data || "locationText" in data) {
        const locationId = data.locationId ?? null;
        if (locationId && locationId !== current.locationId) {
          await this.requireLocation(tx, context.clubId, locationId);
        }
        next.locationId = locationId;
        next.locationText = locationId ? null : (data.locationText ?? null);
      }
      if (data.questions !== undefined) {
        const questions = parseInput(EventQuestionsSchema, data.questions);
        const answered = await repo.answeredQuestionIds(tx, eventId);
        const before = new Map(current.questions.map((q) => [q.id, q]));
        const after = new Map(questions.map((q) => [q.id, q]));
        for (const id of answered) {
          const was = before.get(id);
          const now = after.get(id);
          if (was && (!now || now.type !== was.type || now.sensitive !== was.sensitive)) {
            throw new DomainError("questions_locked");
          }
        }
        // Sealed answers are kept as they are: a question cannot turn sensitive afterwards.
        if (
          questions.some((q) => q.sensitive !== (before.get(q.id)?.sensitive ?? q.sensitive)) &&
          (await repo.hasSensitiveAnswers(tx, eventId))
        ) {
          throw new DomainError("questions_locked");
        }
        next.questions = questions;
      }
      const startsAt = next.startsAt ?? current.startsAt;
      const endsAt = next.endsAt ?? current.endsAt;
      if (endsAt.getTime() <= startsAt.getTime()) throw new DomainError("invalid_input");
      this.checkDeadlines({
        startsAt,
        registrationOpensAt:
          next.registrationOpensAt === undefined
            ? current.registrationOpensAt
            : next.registrationOpensAt,
        registrationClosesAt: next.registrationClosesAt ?? current.registrationClosesAt,
      });
      if (next.capacity !== undefined && next.capacity !== null) {
        const counts = (await repo.countsOf(tx, [eventId])).get(eventId);
        if ((counts?.confirmed ?? 0) > next.capacity) {
          throw new DomainError("capacity_below_confirmed");
        }
      }
      const changed = Object.keys(next).filter(
        (key) =>
          JSON.stringify(next[key as keyof typeof next]) !==
          JSON.stringify(current[key as keyof repo.EventRow]),
      );
      if (changed.length === 0) return (await this.views(tx, context.clubId, [current]))[0]!;
      const event = await repo.updateEvent(tx, eventId, next);
      await audit.record(tx, {
        action: "event.updated",
        resourceType: "event",
        resourceId: eventId,
        changedFields: changed,
      });
      await this.publishChange(tx, event, "updated");
      await this.moveUp(tx, context, event);
      return (await this.views(tx, context.clubId, [event]))[0]!;
    });
  }

  publishEvent(context: TenantContext, eventId: string): Promise<EventView> {
    return this.db.withTenant(context, async (tx) => {
      const current = await repo.lockEvent(tx, eventId);
      if (!current) throw new DomainError("not_found");
      if (current.status !== "draft") throw new DomainError("event_not_draft");
      const event = await repo.updateEvent(tx, eventId, { status: "published" });
      await audit.record(tx, {
        action: "event.published",
        resourceType: "event",
        resourceId: eventId,
      });
      await this.publishChange(tx, event, "published");
      return (await this.views(tx, context.clubId, [event]))[0]!;
    });
  }

  /** Cancels the event and its activities; registrations are kept, offers lapse. */
  cancelEvent(context: TenantContext, eventId: string, reason: string | null): Promise<EventView> {
    return this.db.withTenant(context, async (tx) => {
      const current = await repo.lockEvent(tx, eventId);
      if (!current) throw new DomainError("not_found");
      if (current.status === "cancelled") throw new DomainError("event_cancelled");
      const event = await repo.updateEvent(tx, eventId, {
        status: "cancelled",
        cancelledReason: reason,
      });
      const activityIds = (await repo.activitiesOfEvents(tx, [eventId])).get(eventId) ?? [];
      await this.deps.activities.cancelActivitiesInTx(tx, context, activityIds, reason);
      await audit.record(tx, {
        action: "event.cancelled",
        resourceType: "event",
        resourceId: eventId,
      });
      await this.publishChange(tx, event, "cancelled");
      return (await this.views(tx, context.clubId, [event]))[0]!;
    });
  }

  /** Drafts only; their activities stay, without the event's call-up. */
  deleteEvent(context: TenantContext, eventId: string): Promise<void> {
    return this.db.withTenant(context, async (tx) => {
      const current = await repo.lockEvent(tx, eventId);
      if (!current) throw new DomainError("not_found");
      if (current.status !== "draft") throw new DomainError("event_not_draft");
      const activityIds = (await repo.activitiesOfEvents(tx, [eventId])).get(eventId) ?? [];
      for (const id of activityIds) await this.deps.attendance.setCallUpInTx(tx, context, id, null);
      await repo.deleteEvent(tx, eventId);
      await audit.record(tx, {
        action: "event.deleted",
        resourceType: "event",
        resourceId: eventId,
      });
      await this.publishChange(tx, current, "deleted");
    });
  }

  /**
   * Links exactly these activities: of the club, for a group event only of
   * its audience groups, not in another event and without a call-up of
   * their own. Linked activities are called up to the confirmed
   * participants; unlinked ones lose the event's call-up.
   */
  setActivities(
    context: TenantContext,
    eventId: string,
    input: { activityIds: readonly string[] },
  ): Promise<EventView> {
    return this.db.withTenant(context, async (tx) => {
      const data = parseInput(SetEventActivitiesSchema, input);
      const event = await repo.lockEvent(tx, eventId);
      if (!event) throw new DomainError("not_found");
      if (event.status === "cancelled") throw new DomainError("event_cancelled");
      const wanted = [...new Set(data.activityIds)];
      const current = (await repo.activitiesOfEvents(tx, [eventId])).get(eventId) ?? [];
      const added = wanted.filter((id) => !current.includes(id));
      const removed = current.filter((id) => !wanted.includes(id));
      const targets = await this.deps.attendance.callUpTargetsInTx(tx, added);
      if (targets.length !== added.length) throw new DomainError("not_found");
      const audienceGroups = new Set((await repo.groupsOfEvents(tx, [eventId])).get(eventId));
      const owners = await repo.eventsOfActivities(tx, added);
      for (const t of targets) {
        if (owners.has(t.id)) throw new DomainError("activity_in_other_event");
        if (t.inviteesOnly && t.invitedCount > 0) throw new DomainError("activity_has_call_up");
        if (event.audience === "groups" && !t.groupIds.every((g) => audienceGroups.has(g))) {
          throw new DomainError("group_not_managed");
        }
      }
      if (added.length === 0 && removed.length === 0) {
        return (await this.views(tx, context.clubId, [event]))[0]!;
      }
      await repo.removeEventActivities(tx, eventId, removed);
      for (const id of removed) await this.deps.attendance.setCallUpInTx(tx, context, id, null);
      await repo.addEventActivities(tx, context.clubId, eventId, added);
      const confirmed = await repo.confirmedPeople(tx, eventId);
      for (const id of added) await this.deps.attendance.setCallUpInTx(tx, context, id, confirmed);
      await audit.record(tx, {
        action: "event.updated",
        resourceType: "event",
        resourceId: eventId,
        changedFields: ["activities"],
      });
      await this.publishChange(tx, event, "updated");
      return (await this.views(tx, context.clubId, [event]))[0]!;
    });
  }

  /** A page of the club's or a group's events the scope admits (the caller filters each). */
  listEvents(
    context: TenantContext,
    input: { groupId: string | null; scope: EventScope; query: EventListQuery },
  ): Promise<{ items: EventView[]; nextCursor: string | null }> {
    return this.db.withTenant(context, async (tx) => {
      const rows = await repo.listEvents(tx, {
        clubId: context.clubId,
        groupId: input.groupId,
        scope: input.scope,
        from: input.query.from ? new Date(input.query.from) : null,
        to: input.query.to ? new Date(input.query.to) : null,
        cursor: input.query.cursor ?? null,
        limit: input.query.limit + 1,
      });
      const page = rows.slice(0, input.query.limit);
      return {
        items: await this.views(tx, context.clubId, page),
        nextCursor: rows.length > input.query.limit ? page.at(-1)!.id : null,
      };
    });
  }

  /** Audience group IDs of these events (policy references for each list item). */
  groupIdsOf(context: TenantContext, eventIds: readonly string[]): Promise<Map<string, string[]>> {
    return this.db.withTenant(context, (tx) => repo.groupsOfEvents(tx, eventIds));
  }

  /** The events of these people across clubs (row-level security: the actor's own). */
  eventsForPeople(
    context: Parameters<Database["withActor"]>[0],
    input: { personIds: readonly string[]; cursor: string | null; limit: number },
  ): Promise<{
    items: EventView[];
    registrations: RegistrationView[];
    nextCursor: string | null;
  }> {
    return this.db.withActor(context, async (tx) => {
      const rows = await repo.eventsForPeople(tx, {
        personIds: input.personIds,
        now: this.now(),
        cursor: input.cursor,
        limit: input.limit + 1,
      });
      const page = rows.slice(0, input.limit);
      const byClub = new Map<string, repo.EventRow[]>();
      for (const e of page) byClub.set(e.clubId, [...(byClub.get(e.clubId) ?? []), e]);
      const views = new Map<string, EventView>();
      for (const [clubId, events] of byClub) {
        for (const v of await this.views(tx, clubId, events)) views.set(v.event.id, v);
      }
      const registrations = await repo.registrationsOf(
        tx,
        page.map((e) => e.id),
        input.personIds,
      );
      const positions = await repo.positionsOf(
        tx,
        page.map((e) => e.id),
      );
      return {
        items: page.flatMap((e) => views.get(e.id) ?? []),
        registrations: registrations.map((r) => ({
          registration: r,
          position: positions.get(r.id) ?? null,
          sensitiveAnswers: null,
        })),
        nextCursor: rows.length > input.limit ? page.at(-1)!.id : null,
      };
    });
  }

  // --- Registrations -------------------------------------------------------------------

  /**
   * The registrations of these people (the caller's family) to the event,
   * with sealed answers unsealed for `unsealFor` (the caller decided who may
   * see them).
   */
  familyRegistrations(
    context: TenantContext,
    eventId: string,
    personIds: readonly string[],
    unsealFor: ReadonlySet<string>,
  ): Promise<RegistrationView[]> {
    return this.db.withTenant(context, async (tx) => {
      const rows = await repo.registrationsOf(tx, [eventId], personIds);
      return this.registrationViews(tx, eventId, rows, (r) => unsealFor.has(r.personId));
    });
  }

  /** Confirmed participants (IDs; the caller presents those the viewer may see). */
  confirmedPeople(context: TenantContext, eventId: string): Promise<string[]> {
    return this.db.withTenant(context, (tx) => repo.confirmedPeople(tx, eventId));
  }

  /**
   * Signs up the person, or changes the answers of an open registration
   * (until the sign-up closes). The caller has checked that the person is
   * the actor or a ward with sign_up, and in the audience. With the event
   * locked: a free place confirms, otherwise the queue (or event_full).
   */
  register(
    context: TenantContext,
    eventId: string,
    personId: string,
    input: RegisterInput,
  ): Promise<RegistrationResult> {
    return this.db.withTenant(context, async (tx) => {
      const data = parseInput(RegisterSchema, input);
      const event = await repo.lockEvent(tx, eventId);
      if (!event) throw new DomainError("not_found");
      this.requireSignUpOpen(event);
      const answers = validAnswers(event.questions, data.answers);
      const { plain, sensitive } = splitAnswers(event.questions, answers);
      const existing = await repo.lockOpenRegistration(tx, eventId, personId);
      if (existing) {
        const sealedBefore = existing.sensitiveAnswers
          ? await this.unseal(tx, existing.id, existing.sensitiveAnswers)
          : {};
        const changed = event.questions
          .map((q) => q.id)
          .filter((id) => {
            const before = existing.answers[id] ?? sealedBefore[id];
            return JSON.stringify(before) !== JSON.stringify(answers[id]);
          });
        if (changed.length === 0) return this.result(tx, context, event, existing);
        const updated = await repo.updateRegistration(tx, existing.id, {
          answers: plain,
          sensitiveAnswers: await this.seal(tx, context.clubId, existing.id, sensitive),
        });
        await audit.record(tx, {
          action: "event.registration.updated",
          resourceType: "event_registration",
          resourceId: existing.id,
          // Question IDs only, never values.
          changedFields: changed,
        });
        return this.result(tx, context, event, updated);
      }
      const taken = await this.taken(tx, event.id);
      const free = event.capacity === null || taken < event.capacity;
      if (!free && event.waitlistMode === "none") throw new DomainError("event_full");
      const id = uuidv7();
      const registration = await repo.insertRegistration(tx, {
        id,
        clubId: context.clubId,
        eventId,
        personId,
        registeredByPersonId: actorPersonId(context),
        status: free ? "confirmed" : "waitlisted",
        queuedAt: this.now(),
        answers: plain,
        sensitiveAnswers: await this.seal(tx, context.clubId, id, sensitive),
      });
      await audit.record(tx, {
        action: "event.registration.created",
        resourceType: "event_registration",
        resourceId: id,
      });
      await this.registrationChanged(tx, registration);
      if (free) await this.syncCallUp(tx, context, eventId);
      return this.result(tx, context, event, registration);
    });
  }

  /**
   * Cancels the person's registration: a place until the cancellation
   * deadline, a place in the queue or an offer at any time. A freed place
   * goes to the next one.
   */
  cancelRegistration(
    context: TenantContext,
    eventId: string,
    personId: string,
  ): Promise<RegistrationResult> {
    return this.db.withTenant(context, async (tx) => {
      const event = await repo.lockEvent(tx, eventId);
      if (!event) throw new DomainError("not_found");
      const current = await repo.lockOpenRegistration(tx, eventId, personId);
      if (!current) throw new DomainError("not_registered");
      const deadline = event.cancellationClosesAt ?? event.registrationClosesAt;
      if (current.status === "confirmed" && this.now() > deadline) {
        throw new DomainError("cancellation_closed");
      }
      const registration = await this.endRegistration(tx, context, event, current, "cancelled");
      await audit.record(tx, {
        action: "event.registration.cancelled",
        resourceType: "event_registration",
        resourceId: current.id,
      });
      return this.result(tx, context, event, registration);
    });
  }

  /** Accepts an offered place (until the offer expires, also after the sign-up closed). */
  acceptOffer(
    context: TenantContext,
    eventId: string,
    personId: string,
  ): Promise<RegistrationResult> {
    return this.db.withTenant(context, async (tx) => {
      const event = await repo.lockEvent(tx, eventId);
      if (!event) throw new DomainError("not_found");
      if (event.status === "cancelled") throw new DomainError("event_cancelled");
      const current = await repo.lockOpenRegistration(tx, eventId, personId);
      if (current?.status !== "offered") throw new DomainError("no_offer");
      if (current.offerExpiresAt && current.offerExpiresAt <= this.now()) {
        throw new DomainError("offer_expired");
      }
      const registration = await repo.updateRegistration(tx, current.id, {
        status: "confirmed",
        offerExpiresAt: null,
      });
      await audit.record(tx, {
        action: "event.registration.accepted",
        resourceType: "event_registration",
        resourceId: current.id,
      });
      await this.registrationChanged(tx, registration);
      await this.syncCallUp(tx, context, eventId);
      return this.result(tx, context, event, registration);
    });
  }

  /** Declines an offered place: it goes to the next one. */
  declineOffer(
    context: TenantContext,
    eventId: string,
    personId: string,
  ): Promise<RegistrationResult> {
    return this.db.withTenant(context, async (tx) => {
      const event = await repo.lockEvent(tx, eventId);
      if (!event) throw new DomainError("not_found");
      const current = await repo.lockOpenRegistration(tx, eventId, personId);
      if (current?.status !== "offered") throw new DomainError("no_offer");
      const registration = await this.endRegistration(tx, context, event, current, "declined");
      await audit.record(tx, {
        action: "event.registration.declined",
        resourceType: "event_registration",
        resourceId: current.id,
      });
      return this.result(tx, context, event, registration);
    });
  }

  /** Organisers: moves a waiting (or offered) registration up out of order, with a reason. */
  confirmRegistration(
    context: TenantContext,
    eventId: string,
    personId: string,
    reason: string,
  ): Promise<RegistrationResult> {
    return this.db.withTenant(context, async (tx) => {
      const event = await repo.lockEvent(tx, eventId);
      if (!event) throw new DomainError("not_found");
      if (event.status === "cancelled") throw new DomainError("event_cancelled");
      const current = await repo.lockOpenRegistration(tx, eventId, personId);
      if (!current) throw new DomainError("not_registered");
      if (current.status === "confirmed") throw new DomainError("already_registered");
      if (current.status === "waitlisted" && event.capacity !== null) {
        if ((await this.taken(tx, eventId)) >= event.capacity) throw new DomainError("event_full");
      }
      const registration = await repo.updateRegistration(tx, current.id, {
        status: "confirmed",
        offerExpiresAt: null,
        decisionReason: reason,
        decidedByPersonId: actorPersonId(context),
        decidedAt: this.now(),
      });
      await audit.record(tx, {
        action: "event.registration.confirmed",
        resourceType: "event_registration",
        resourceId: current.id,
        changedFields: ["status", "decision_reason"],
      });
      await this.registrationChanged(tx, registration);
      await outbox.publish(tx, "event.offer.made", {
        clubId: event.clubId,
        eventId,
        registrationId: current.id,
        personId,
        kind: "confirmed",
      });
      await this.syncCallUp(tx, context, eventId);
      return this.result(tx, context, event, registration);
    });
  }

  /** Organisers: removes a registration with a reason; a freed place goes to the next one. */
  removeRegistration(
    context: TenantContext,
    eventId: string,
    personId: string,
    reason: string,
  ): Promise<RegistrationResult> {
    return this.db.withTenant(context, async (tx) => {
      const event = await repo.lockEvent(tx, eventId);
      if (!event) throw new DomainError("not_found");
      const current = await repo.lockOpenRegistration(tx, eventId, personId);
      if (!current) throw new DomainError("not_registered");
      const registration = await this.endRegistration(tx, context, event, current, "removed", {
        decisionReason: reason,
        decidedByPersonId: actorPersonId(context),
        decidedAt: this.now(),
      });
      await audit.record(tx, {
        action: "event.registration.removed",
        resourceType: "event_registration",
        resourceId: current.id,
        changedFields: ["status", "decision_reason"],
      });
      return this.result(tx, context, event, registration);
    });
  }

  /** The organisers' list (sensitive answers unsealed when `sensitive`). */
  registrationList(
    context: TenantContext,
    eventId: string,
    query: RegistrationListQuery,
    options: { sensitive: boolean },
  ): Promise<{ items: RegistrationView[]; nextCursor: string | null; counts: EventCounts }> {
    return this.db.withTenant(context, async (tx) => {
      const event = await repo.findEvent(tx, eventId);
      if (!event) throw new DomainError("not_found");
      const rows = await repo.registrationPage(tx, {
        eventId,
        status: query.status ?? null,
        cursor: query.cursor ?? null,
        limit: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      const counts = await this.countsFor(tx, [event]);
      return {
        items: await this.registrationViews(tx, eventId, page, () => options.sensitive),
        nextCursor: rows.length > query.limit ? page.at(-1)!.id : null,
        counts: counts.get(eventId)!,
      };
    });
  }

  /** Every registration for the export; audited with whether sensitive answers were included. */
  exportRegistrations(
    context: TenantContext,
    eventId: string,
    options: { sensitive: boolean },
  ): Promise<{ event: repo.EventRow; items: RegistrationView[] }> {
    return this.db.withTenant(context, async (tx) => {
      const event = await repo.findEvent(tx, eventId);
      if (!event) throw new DomainError("not_found");
      const rows = await repo.allRegistrations(tx, eventId);
      await audit.record(tx, {
        action: "event.registrations.exported",
        resourceType: "event",
        resourceId: eventId,
        changedFields: options.sensitive ? ["sensitive_answers"] : [],
      });
      return {
        event,
        items: await this.registrationViews(tx, eventId, rows, () => options.sensitive),
      };
    });
  }

  /**
   * Expires an offer past its time and offers the place to the next one
   * (the API's job runner, as system for the club). Nothing happens when it
   * was answered meanwhile.
   */
  expireOffer(clubId: string, registrationId: string): Promise<void> {
    return this.db.withSystem("events:expire_offers", { clubId }, async (tx) => {
      const found = await repo.findRegistration(tx, registrationId);
      if (!found) return;
      const event = await repo.lockEvent(tx, found.eventId);
      if (!event) return;
      const current = await repo.lockOpenRegistration(tx, found.eventId, found.personId);
      if (current?.id !== registrationId || current.status !== "offered") return;
      if (!current.offerExpiresAt || current.offerExpiresAt > this.now()) return;
      // The transaction runs as the system job; call-ups name the organiser as inviter.
      const context: TenantContext = { clubId, actorKind: "anonymous", personId: null };
      await this.endRegistration(tx, context, event, current, "expired");
      await audit.record(tx, {
        action: "event.registration.expired",
        resourceType: "event_registration",
        resourceId: registrationId,
      });
    });
  }

  /** Offers due to expire (IDs), across clubs. */
  dueOffers(limit: number): Promise<{ id: string; clubId: string }[]> {
    return this.db.withSystem("events:expire_offers", {}, (tx) => repo.dueOffers(tx, limit));
  }

  // --- Internals ----------------------------------------------------------------------

  private requireSignUpOpen(event: repo.EventRow): void {
    const now = this.now();
    if (event.status === "cancelled") throw new DomainError("event_cancelled");
    if (event.status !== "published") throw new DomainError("event_not_published");
    if (event.registrationOpensAt && now < event.registrationOpensAt) {
      throw new DomainError("registration_not_open");
    }
    if (now > event.registrationClosesAt) throw new DomainError("registration_closed");
  }

  private checkDeadlines(e: {
    startsAt: Date;
    registrationOpensAt: Date | null;
    registrationClosesAt: Date;
  }): void {
    if (e.registrationOpensAt && e.registrationOpensAt >= e.registrationClosesAt) {
      throw new DomainError("invalid_input");
    }
  }

  private async requireLocation(tx: Tx, clubId: string, locationId: string): Promise<void> {
    const [location] = await this.deps.activities.locationsInTx(tx, [locationId]);
    if (location?.clubId !== clubId) throw new DomainError("not_found");
    if (location.archivedAt) throw new DomainError("location_archived");
  }

  /** Places taken: confirmed and offered (the event is locked). */
  private async taken(tx: Tx, eventId: string): Promise<number> {
    const counts = (await repo.countsOf(tx, [eventId])).get(eventId);
    return (counts?.confirmed ?? 0) + (counts?.offered ?? 0);
  }

  /** Ends an open registration; a freed place goes to the next in the queue. */
  private async endRegistration(
    tx: Tx,
    context: TenantContext,
    event: repo.EventRow,
    current: repo.RegistrationRow,
    status: Extract<RegistrationStatus, "cancelled" | "declined" | "expired" | "removed">,
    extra: Partial<repo.NewRegistrationRow> = {},
  ): Promise<repo.RegistrationRow> {
    const registration = await repo.updateRegistration(tx, current.id, {
      status,
      offerExpiresAt: null,
      ...extra,
    });
    await this.registrationChanged(tx, registration);
    if (current.status === "confirmed" || current.status === "offered") {
      await this.moveUp(tx, context, event);
    }
    if (current.status === "confirmed") await this.syncCallUp(tx, context, event.id);
    return registration;
  }

  /**
   * Gives free places to the queue in order: confirmed (`auto`) or offered
   * (`offer`). Nothing moves for a cancelled event or without a waiting list.
   */
  private async moveUp(tx: Tx, context: TenantContext, event: repo.EventRow): Promise<void> {
    if (event.status !== "published" || event.waitlistMode === "none") return;
    const now = this.now();
    const free =
      event.capacity === null
        ? Number.MAX_SAFE_INTEGER
        : event.capacity - (await this.taken(tx, event.id));
    const next = await repo.nextWaiting(tx, event.id, Math.min(free, 1000));
    if (next.length === 0) return;
    for (const waiting of next) {
      const offer = event.waitlistMode === "offer";
      const moved = await repo.updateRegistration(tx, waiting.id, {
        status: offer ? "offered" : "confirmed",
        offerExpiresAt: offer ? new Date(now.getTime() + event.offerReplyHours * HOUR_MS) : null,
      });
      await audit.record(tx, {
        action: offer ? "event.registration.offered" : "event.registration.updated",
        resourceType: "event_registration",
        resourceId: waiting.id,
        changedFields: ["status"],
      });
      await this.registrationChanged(tx, moved);
      await outbox.publish(tx, "event.offer.made", {
        clubId: event.clubId,
        eventId: event.id,
        registrationId: waiting.id,
        personId: waiting.personId,
        kind: offer ? "offered" : "confirmed",
      });
    }
    if (event.waitlistMode === "auto") await this.syncCallUp(tx, context, event.id);
  }

  /** The event's activities are called up to exactly the confirmed participants. */
  private async syncCallUp(tx: Tx, context: TenantContext, eventId: string): Promise<void> {
    const activityIds = (await repo.activitiesOfEvents(tx, [eventId])).get(eventId) ?? [];
    if (activityIds.length === 0) return;
    const confirmed = await repo.confirmedPeople(tx, eventId);
    const event = await repo.findEvent(tx, eventId);
    for (const id of activityIds) {
      await this.deps.attendance.setCallUpInTx(tx, context, id, confirmed, {
        invitedBy: context.personId ?? event!.createdByPersonId,
      });
    }
  }

  private async registrationChanged(tx: Tx, r: repo.RegistrationRow): Promise<void> {
    await outbox.publish(tx, "event.registration.changed", {
      clubId: r.clubId,
      eventId: r.eventId,
      registrationId: r.id,
      personId: r.personId,
    });
  }

  private async publishChange(
    tx: Tx,
    event: repo.EventRow,
    change: "created" | "updated" | "published" | "cancelled" | "deleted",
  ): Promise<void> {
    await outbox.publish(tx, "event.changed", { clubId: event.clubId, eventId: event.id, change });
  }

  private async seal(
    tx: Tx,
    clubId: string,
    registrationId: string,
    sensitive: Answers,
  ): Promise<string | null> {
    if (Object.keys(sensitive).length === 0) return null;
    return this.deps.encryption.encrypt(
      tx,
      clubId,
      JSON.stringify(sensitive),
      sensitiveAad(registrationId),
    );
  }

  private async unseal(tx: Tx, registrationId: string, sealed: string): Promise<Answers> {
    return JSON.parse(
      await this.deps.encryption.decrypt(tx, sealed, sensitiveAad(registrationId)),
    ) as Answers;
  }

  private async result(
    tx: Tx,
    context: TenantContext,
    event: repo.EventRow,
    registration: repo.RegistrationRow,
  ): Promise<RegistrationResult> {
    const fresh = (await repo.findEvent(tx, event.id)) ?? event;
    const [view] = await this.views(tx, context.clubId, [fresh]);
    const [reg] = await this.registrationViews(tx, event.id, [registration], () => true);
    return { view: view!, registration: reg! };
  }

  private async registrationViews(
    tx: Tx,
    eventId: string,
    rows: readonly repo.RegistrationRow[],
    unseal: (row: repo.RegistrationRow) => boolean,
  ): Promise<RegistrationView[]> {
    const positions = rows.some((r) => r.status === "waitlisted")
      ? await repo.positionsOf(tx, [eventId])
      : new Map<string, number>();
    const views: RegistrationView[] = [];
    for (const r of rows) {
      views.push({
        registration: r,
        position: positions.get(r.id) ?? null,
        sensitiveAnswers:
          r.sensitiveAnswers && unseal(r) ? await this.unseal(tx, r.id, r.sensitiveAnswers) : null,
      });
    }
    return views;
  }

  private async countsFor(
    tx: Tx,
    events: readonly repo.EventRow[],
  ): Promise<Map<string, EventCounts>> {
    const counts = await repo.countsOf(
      tx,
      events.map((e) => e.id),
    );
    return new Map(
      events.map((e) => {
        const c = counts.get(e.id) ?? { confirmed: 0, offered: 0, waiting: 0 };
        return [
          e.id,
          {
            ...c,
            placesLeft:
              e.capacity === null ? null : Math.max(0, e.capacity - c.confirmed - c.offered),
          },
        ];
      }),
    );
  }

  private async views(
    tx: Tx,
    clubId: string,
    events: readonly repo.EventRow[],
  ): Promise<EventView[]> {
    if (events.length === 0) return [];
    const ids = events.map((e) => e.id);
    const club = await this.deps.clubs.getClubInTx(tx, clubId);
    // One connection: the statements run one after the other.
    const groupIds = await repo.groupsOfEvents(tx, ids);
    const activityIds = await repo.activitiesOfEvents(tx, ids);
    const counts = await this.countsFor(tx, events);
    const groupNames = await this.deps.activities.groupNamesInTx(tx, clubId, [
      ...new Set([...groupIds.values()].flat()),
    ]);
    const activities = new Map(
      (
        await this.deps.activities.activitiesInTx(tx, [
          ...new Set([...activityIds.values()].flat()),
        ])
      ).map((a) => [a.id, a]),
    );
    const locations = new Map(
      (
        await this.deps.activities.locationsInTx(tx, [
          ...new Set(events.flatMap((e) => (e.locationId ? [e.locationId] : []))),
        ])
      ).map((l) => [l.id, l]),
    );
    const now = this.now();
    return events.map((event) => {
      const location = event.locationId ? locations.get(event.locationId) : undefined;
      return {
        event,
        timeZone: club.timeZone,
        groups: (groupIds.get(event.id) ?? [])
          .flatMap((id) => {
            const name = groupNames.get(id);
            return name === undefined ? [] : [{ id, name }];
          })
          .sort((a, b) => a.name.localeCompare(b.name)),
        location: location ?? null,
        counts: counts.get(event.id)!,
        open: isOpen(event, now),
        activities: (activityIds.get(event.id) ?? [])
          .flatMap((id) => activities.get(id) ?? [])
          .map((a) => ({
            id: a.id,
            kind: a.kind,
            title: a.title,
            status: a.status,
            startsAt: a.startsAt,
            endsAt: a.endsAt,
          }))
          .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()),
      };
    });
  }
}
