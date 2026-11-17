// SPDX-License-Identifier: AGPL-3.0-only
// Car pooling (P2.5 part A, ADR 0048).
//
// - An activity with own transport (transport_mode `own`; a series' sessions
//   and an event's sessions inherit it) opens its car pool until it starts.
// - Adults taking part, or guardians of a participant, offer a car (seats,
//   a departure place and time) or are "willing to drive"; the return trip
//   is a copy of the outward one, changed on its own.
// - Seats are booked for oneself (an adult; a child from the age their
//   guardians allow: the highest of their choices, each one's default the
//   country pack's), or by a guardian for their child; the return seat in
//   the same car with it.
// - The rule of two (rule-of-two.ts) is settled after every change of a
//   car's seats: a single child alone with an adult not their guardian waits
//   for a guardian's confirmation; a guardian booking may confirm at once.
// - Notices go out through the outbox (`carpool.changed`): the driver on a
//   booking or cancellation, the bookers on a car's change or removal, the
//   guardians when a confirmation is asked. Fixed texts, IDs only.
// Who may read the car pool (activity.read) and settings are the
// controller's; who may offer, book, cancel and confirm is decided here,
// from the people's facts read in the same transaction.

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
  type BookCarpoolSeatInput,
  BookCarpoolSeatSchema,
  CARPOOL_SELF_BOOKING_AGE,
  type CarpoolBookingStatus,
  type CarpoolDirection,
  type CreateCarpoolOfferInput,
  CreateCarpoolOfferSchema,
  type UpdateCarpoolOfferInput,
  UpdateCarpoolOfferSchema,
} from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { actorPersonId, parseInput } from "../../platform/domain/run.ts";
import type { GuardianshipsService } from "../guardianships/index.ts";
import * as repo from "./carpools.repository.ts";
import { type CarFacts, settleSeats } from "./rule-of-two.ts";

export type {
  ActivityFacts,
  BookingRow,
  DriveRow,
  MyCarpoolRow,
  OfferRow,
  StatsRow,
} from "./carpools.repository.ts";

/** The car pool as the controller presents it (who sees whom is the controller's). */
export interface CarpoolView {
  activity: repo.ActivityFacts;
  offers: repo.OfferRow[];
  /** The car pool takes changes (own transport, scheduled, not started). */
  open: boolean;
  canOffer: boolean;
  /** Whom the caller may book a seat for. */
  bookFor: string[];
  /** Participants without a seat out (for leaders). */
  withoutRide: string[];
  /** Whether the person is the caller, or a ward of theirs. */
  family: (personId: string) => boolean;
  /** Whether the caller may cancel or confirm a booking. */
  canCancel: (booking: repo.BookingRow, driverPersonId: string) => boolean;
  canConfirm: (booking: repo.BookingRow) => boolean;
}

/** The people's facts the rules need, read once per request. */
class People {
  private readonly facts: Map<string, repo.PersonFacts>;
  private readonly adultAge: number;
  private readonly defaultAge: number;
  private readonly on: Date;

  constructor(facts: Map<string, repo.PersonFacts>, country: string, on: Date) {
    this.facts = facts;
    const rules = isSupportedCountry(country) ? getCountryPack(country).ageRules : null;
    this.adultAge = rules?.adultAge ?? 18;
    this.defaultAge = rules?.childSelfBookingAge ?? CARPOOL_SELF_BOOKING_AGE;
    this.on = on;
  }

  /** Below the adult age on the activity's start; unknown age: a child if they have a guardian. */
  isChild(personId: string): boolean {
    const f = this.facts.get(personId);
    if (!f) return true;
    return f.birthDate ? ageOn(f.birthDate, this.on) < this.adultAge : f.guardians.length > 0;
  }

  guardiansOf(personId: string, right?: string): string[] {
    return (this.facts.get(personId)?.guardians ?? [])
      .filter((g) => right === undefined || g.rights.includes(right))
      .map((g) => g.personId);
  }

  /** Whether the child may book seats themselves (the highest of their guardians' ages). */
  maySelfBook(personId: string): boolean {
    const f = this.facts.get(personId);
    if (!f?.birthDate) return false;
    const ages = f.guardians.map((g) => g.carpoolAge ?? this.defaultAge);
    const age = ages.length > 0 ? Math.max(...ages) : this.defaultAge;
    return ageOn(f.birthDate, this.on) >= age;
  }
}

interface Scope {
  activity: repo.ActivityFacts;
  roster: repo.RosterEntry[];
  people: People;
  /** Roster people and the guardians of its participants. */
  eligible: Set<string>;
}

type Notice = {
  kind: "booked" | "cancelled" | "offer_changed" | "offer_removed" | "confirm";
  /** The car's driver (the notice links to the car pool). */
  driverPersonId: string;
  personIds: string[];
};

export class CarpoolsService {
  private readonly db: Database;
  private readonly guardianships: GuardianshipsService;
  private readonly now: () => Date;

  constructor(db: Database, deps: { guardianships: GuardianshipsService; now?: () => Date }) {
    this.db = db;
    this.guardianships = deps.guardianships;
    this.now = deps.now ?? (() => new Date());
  }

  // --- Reading ------------------------------------------------------------------

  carpool(context: TenantContext, activityId: string): Promise<CarpoolView> {
    const me = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      const offers = await repo.offers(tx, activityId);
      const scope = await this.scope(tx, activityId, [
        me,
        ...offers.flatMap((o) => [o.driverPersonId, ...o.bookings.map((b) => b.passengerPersonId)]),
      ]);
      const { people, roster, eligible } = scope;
      const open = this.isOpen(scope.activity);
      const wards = new Set(
        roster
          .filter((r) => people.guardiansOf(r.personId, "sign_up").includes(me))
          .map((r) => r.personId),
      );
      const family = (personId: string) =>
        personId === me || people.guardiansOf(personId).includes(me);
      const seatedOut = new Set(
        offers
          .filter((o) => o.direction === "out")
          .flatMap((o) => o.bookings.map((b) => b.passengerPersonId)),
      );
      const drivers = new Set(offers.filter((o) => !o.willingOnly).map((o) => o.driverPersonId));
      const bookFor = open
        ? [
            ...(eligible.has(me) && (!people.isChild(me) || people.maySelfBook(me)) ? [me] : []),
            ...[...wards].filter((w) => w !== me),
          ]
        : [];
      return {
        activity: scope.activity,
        offers,
        open,
        canOffer: open && eligible.has(me) && !people.isChild(me),
        bookFor,
        withoutRide: roster
          .filter(
            (r) =>
              r.role === "participant" && !seatedOut.has(r.personId) && !drivers.has(r.personId),
          )
          .map((r) => r.personId),
        family,
        canCancel: (b, driver) =>
          open &&
          (family(b.passengerPersonId) ||
            b.bookedByPersonId === me ||
            people.guardiansOf(b.passengerPersonId, "sign_up").includes(me) ||
            driver === me),
        canConfirm: (b) =>
          b.status === "pending_guardian" &&
          people.guardiansOf(b.passengerPersonId, "act_on_behalf").includes(me),
      };
    });
  }

  /** "Mina samåkningar": the caller's drives and their own and wards' seats. */
  myCarpools(context: ActorContext, limit = 100): Promise<repo.MyCarpoolRow[]> {
    return this.db.withActor(context, (tx) => repo.myCarpools(tx, limit));
  }

  /** Statistics of the group's activities that started in the period. */
  stats(
    context: TenantContext,
    groupId: string,
    range: { from: string; to: string },
  ): Promise<{ rows: repo.StatsRow[]; public: boolean }> {
    const from = new Date(`${range.from}T00:00:00Z`);
    const to = new Date(Date.parse(`${range.to}T00:00:00Z`) + 86_400_000);
    if (!(to > from) || to.getTime() - from.getTime() > 400 * 86_400_000) {
      throw new DomainError("range_too_large");
    }
    return this.db.withTenant(context, async (tx) => ({
      rows: await repo.stats(tx, groupId, { from, to }),
      public: await repo.statsPublic(tx, groupId),
    }));
  }

  // --- Offers ---------------------------------------------------------------------

  createOffer(
    context: TenantContext,
    activityId: string,
    input: CreateCarpoolOfferInput,
  ): Promise<{ id: string; returnId: string | null }> {
    const data = parseInput(CreateCarpoolOfferSchema, input);
    const me = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      await repo.lockActivity(tx, activityId);
      const scope = await this.scope(tx, activityId, [me]);
      this.requireOpen(scope.activity);
      if (!scope.eligible.has(me) || scope.people.isChild(me)) {
        throw new DomainError("carpool_driver_not_eligible");
      }
      const existing = await repo.offers(tx, activityId);
      const directions: CarpoolDirection[] =
        data.withReturn && data.direction === "out" ? ["out", "back"] : [data.direction];
      if (existing.some((o) => o.driverPersonId === me && directions.includes(o.direction))) {
        throw new DomainError("carpool_offer_exists");
      }
      const values = {
        clubId: context.clubId,
        activityId,
        driverPersonId: me,
        willingOnly: data.willingOnly,
        seats: data.willingOnly ? 0 : Math.max(1, data.seats),
        departurePlace: data.departurePlace || null,
        note: data.note || null,
        departureAt: data.departureAt ? new Date(data.departureAt) : null,
      };
      const id = await repo.insertOffer(tx, {
        ...values,
        direction: data.direction,
        outwardOfferId: null,
      });
      const returnId =
        directions.includes("back") && data.direction === "out"
          ? await repo.insertOffer(tx, { ...values, direction: "back", outwardOfferId: id })
          : null;
      await audit.record(tx, {
        action: "carpool.offer.created",
        resourceType: "activity",
        resourceId: activityId,
        changedFields: returnId ? ["out", "back"] : [data.direction],
      });
      return { id, returnId };
    });
  }

  updateOffer(
    context: TenantContext,
    activityId: string,
    offerId: string,
    input: UpdateCarpoolOfferInput,
  ): Promise<void> {
    const data = parseInput(UpdateCarpoolOfferSchema, input);
    const me = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      await repo.lockActivity(tx, activityId);
      const offer = await this.ownOffer(tx, activityId, offerId, me);
      const scope = await this.scope(
        tx,
        activityId,
        offer.bookings.map((b) => b.passengerPersonId),
      );
      // After the start only the distance driven is corrected.
      const tripFields = Object.keys(data).filter((k) => k !== "distanceKm");
      if (tripFields.length > 0) this.requireOpen(scope.activity);
      const willingOnly = data.willingOnly ?? offer.willingOnly;
      const seats = willingOnly ? 0 : Math.max(1, data.seats ?? (offer.seats || 1));
      if (offer.bookings.length > seats) throw new DomainError("carpool_seats_taken");
      const next = {
        willingOnly,
        seats,
        departurePlace:
          data.departurePlace === undefined ? offer.departurePlace : data.departurePlace || null,
        note: data.note === undefined ? offer.note : data.note || null,
        departureAt:
          data.departureAt === undefined
            ? offer.departureAt
            : data.departureAt
              ? new Date(data.departureAt)
              : null,
        distanceKm: data.distanceKm === undefined ? offer.distanceKm : data.distanceKm,
      };
      await repo.updateOffer(tx, offerId, next);
      await audit.record(tx, {
        action: "carpool.offer.updated",
        resourceType: "activity",
        resourceId: activityId,
        changedFields: Object.keys(data),
      });
      // Passengers are told of a change to the trip (not of a distance correction).
      const tripChanged =
        next.departurePlace !== offer.departurePlace ||
        next.note !== offer.note ||
        next.departureAt?.getTime() !== offer.departureAt?.getTime();
      if (tripChanged) {
        await this.notify(tx, scope.activity, me, {
          kind: "offer_changed",
          driverPersonId: me,
          personIds: bookers(offer),
        });
      }
    });
  }

  /** The driver removes their car before the trip; its seats go with it. */
  deleteOffer(context: TenantContext, activityId: string, offerId: string): Promise<void> {
    const me = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      await repo.lockActivity(tx, activityId);
      const offer = await this.ownOffer(tx, activityId, offerId, me);
      const activity = await this.activity(tx, activityId);
      if (activity.startsAt <= this.now()) throw new DomainError("carpool_started");
      await repo.deleteOffer(tx, offerId);
      await audit.record(tx, {
        action: "carpool.offer.deleted",
        resourceType: "activity",
        resourceId: activityId,
        changedFields: ["carpool_offer"],
      });
      await this.notify(tx, activity, me, {
        kind: "offer_removed",
        driverPersonId: me,
        personIds: bookers(offer),
      });
    });
  }

  // --- Bookings ---------------------------------------------------------------------

  book(
    context: TenantContext,
    activityId: string,
    offerId: string,
    input: BookCarpoolSeatInput,
  ): Promise<{ id: string; status: CarpoolBookingStatus; returnId: string | null }> {
    const data = parseInput(BookCarpoolSeatSchema, input);
    const me = actorPersonId(context);
    const passenger = data.passengerPersonId;
    return this.db.withTenant(context, async (tx) => {
      await repo.lockActivity(tx, activityId);
      const offer = await repo.offerForUpdate(tx, offerId);
      if (offer?.activityId !== activityId) throw new DomainError("not_found");
      const all = await repo.offers(tx, activityId);
      const ret = all.find(
        (o) => o.outwardOfferId === offerId && o.driverPersonId === offer.driverPersonId,
      );
      const scope = await this.scope(tx, activityId, [
        me,
        passenger,
        offer.driverPersonId,
        ...offer.bookings.map((b) => b.passengerPersonId),
        ...(ret?.bookings.map((b) => b.passengerPersonId) ?? []),
      ]);
      const { people } = scope;
      this.requireOpen(scope.activity);
      // Who books: the passenger themselves (an adult, or a child from the allowed age) or a guardian.
      if (passenger === me) {
        if (people.isChild(me) && !people.maySelfBook(me)) {
          throw new DomainError("carpool_self_booking_age");
        }
      } else if (!people.guardiansOf(passenger, "sign_up").includes(me)) {
        throw new DomainError("not_allowed");
      }
      if (!scope.eligible.has(passenger)) throw new DomainError("carpool_not_participant");
      const confirmBy =
        data.confirmAlone && people.guardiansOf(passenger, "act_on_behalf").includes(me)
          ? me
          : null;
      const id = await this.bookInto(tx, scope, all, offer, passenger, me, confirmBy);
      let returnId: string | null = null;
      if (data.alsoReturn && ret && !ret.willingOnly && ret.bookings.length < ret.seats) {
        const already = all.some(
          (o) =>
            o.direction === "back" && o.bookings.some((b) => b.passengerPersonId === passenger),
        );
        if (!already) returnId = await this.bookInto(tx, scope, all, ret, passenger, me, confirmBy);
      }
      return { id, status: (await repo.booking(tx, id))?.status ?? "held", returnId };
    });
  }

  cancelBooking(
    context: TenantContext,
    activityId: string,
    offerId: string,
    bookingId: string,
  ): Promise<void> {
    const me = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      await repo.lockActivity(tx, activityId);
      const offer = await repo.offerForUpdate(tx, offerId);
      const booking = offer?.bookings.find((b) => b.id === bookingId);
      if (offer?.activityId !== activityId || !booking) throw new DomainError("not_found");
      const scope = await this.scope(tx, activityId, [
        me,
        offer.driverPersonId,
        ...offer.bookings.map((b) => b.passengerPersonId),
      ]);
      const { people } = scope;
      const allowed =
        booking.passengerPersonId === me ||
        booking.bookedByPersonId === me ||
        people.guardiansOf(booking.passengerPersonId, "sign_up").includes(me) ||
        offer.driverPersonId === me;
      if (!allowed) throw new DomainError("not_allowed");
      this.requireOpen(scope.activity);
      await repo.cancelBooking(tx, bookingId);
      await audit.record(tx, {
        action: "carpool.booking.cancelled",
        resourceType: "activity",
        resourceId: activityId,
        changedFields: ["status"],
      });
      const rest = { ...offer, bookings: offer.bookings.filter((b) => b.id !== bookingId) };
      await this.settle(tx, scope, rest, undefined, me);
      await this.notify(tx, scope.activity, me, {
        kind: "cancelled",
        driverPersonId: offer.driverPersonId,
        personIds: [
          offer.driverPersonId,
          ...(booking.bookedByPersonId ? [booking.bookedByPersonId] : []),
        ],
      });
    });
  }

  /** A guardian confirms their child may be the only child with that driver. */
  async confirm(context: ActorContext, bookingId: string): Promise<void> {
    const me = actorPersonId(context);
    const clubId = await this.db.withActor(context, (tx) => repo.wardBookingClub(tx, bookingId));
    if (!clubId) throw new DomainError("not_found");
    await this.db.withTenant({ ...context, clubId }, async (tx) => {
      const found = await repo.booking(tx, bookingId);
      if (!found) throw new DomainError("not_found");
      await repo.lockActivity(tx, found.activityId);
      const offer = await repo.offerForUpdate(tx, found.offerId);
      const booking = offer?.bookings.find((b) => b.id === bookingId);
      if (!offer || !booking) throw new DomainError("not_found");
      const scope = await this.scope(tx, found.activityId, [
        me,
        offer.driverPersonId,
        ...offer.bookings.map((b) => b.passengerPersonId),
      ]);
      if (!scope.people.guardiansOf(booking.passengerPersonId, "act_on_behalf").includes(me)) {
        throw new DomainError("not_found");
      }
      if (booking.status !== "pending_guardian") throw new DomainError("carpool_not_pending");
      this.requireOpen(scope.activity);
      await this.settle(tx, scope, offer, { bookingId, byPersonId: me }, me);
      await audit.record(tx, {
        action: "carpool.booking.confirmed",
        resourceType: "activity",
        resourceId: found.activityId,
        changedFields: ["confirmed_by_person_id"],
      });
      await this.notify(tx, scope.activity, me, {
        kind: "booked",
        driverPersonId: offer.driverPersonId,
        personIds: [offer.driverPersonId],
      });
    });
  }

  setSelfBookingAge(
    context: ActorContext,
    wardPersonId: string,
    age: number | null,
  ): Promise<void> {
    return this.guardianships.setCarpoolSelfBookingAge(context, wardPersonId, age);
  }

  // --- Drives for expense claims (the expenses module) ---------------------------

  /**
   * The caller's drives of activities that have started, in the caller's
   * tenant transaction; `offerIds`: only these, locked (a claim is made of them).
   */
  drivesInTx(
    tx: Tx,
    driverPersonId: string,
    options: { offerIds?: readonly string[]; limit?: number } = {},
  ): Promise<repo.DriveRow[]> {
    return repo.drives(tx, driverPersonId, {
      ...(options.offerIds ? { offerIds: options.offerIds } : {}),
      limit: options.limit ?? 200,
    });
  }

  // --- Settings and old data ---------------------------------------------------------

  setStatsPublic(context: TenantContext, groupId: string, value: boolean): Promise<void> {
    return this.db.withTenant(context, async (tx) => {
      if (!(await repo.setStatsPublic(tx, groupId, value))) throw new DomainError("not_found");
      await audit.record(tx, {
        action: "carpool.settings.updated",
        resourceType: "group",
        resourceId: groupId,
        changedFields: ["carpool_stats_public"],
      });
    });
  }

  settings(context: TenantContext): Promise<{ startLocationId: string | null }> {
    return this.db.withTenant(context, async (tx) => ({
      startLocationId: await repo.startLocation(tx, context.clubId),
    }));
  }

  setSettings(context: TenantContext, startLocationId: string | null): Promise<void> {
    return this.db.withTenant(context, async (tx) => {
      if (startLocationId && !(await repo.liveLocation(tx, context.clubId, startLocationId))) {
        throw new DomainError("not_found");
      }
      await repo.setStartLocation(tx, context.clubId, startLocationId);
      await audit.record(tx, {
        action: "carpool.settings.updated",
        resourceType: "club",
        resourceId: context.clubId,
        changedFields: ["carpool_start_location_id"],
      });
    });
  }

  /** Deletes the club's car pools of activities that started before the date (at most today). */
  deleteBefore(context: TenantContext, before: string): Promise<number> {
    const date = new Date(`${before}T00:00:00Z`);
    if (date.getTime() > this.now().getTime()) throw new DomainError("carpool_before_invalid");
    return this.db.withTenant(context, async (tx) => {
      const n = await repo.deleteBefore(tx, context.clubId, date);
      await audit.record(tx, {
        action: "carpool.history.deleted",
        resourceType: "club",
        resourceId: context.clubId,
        changedFields: ["carpool_offers"],
      });
      return n;
    });
  }

  // --- Internals -----------------------------------------------------------------------

  private async activity(tx: Tx, activityId: string): Promise<repo.ActivityFacts> {
    const activity = await repo.activityFacts(tx, activityId);
    if (!activity) throw new DomainError("not_found");
    return activity;
  }

  /** The activity, its roster and the facts of the roster and these people. */
  private async scope(tx: Tx, activityId: string, extra: readonly string[]): Promise<Scope> {
    const activity = await this.activity(tx, activityId);
    const roster = await repo.roster(tx, activityId);
    const facts = await repo.personFacts(tx, [...roster.map((r) => r.personId), ...extra]);
    const people = new People(facts, activity.country, activity.startsAt);
    const eligible = new Set(roster.map((r) => r.personId));
    for (const r of roster) {
      if (r.role === "participant") for (const g of people.guardiansOf(r.personId)) eligible.add(g);
    }
    return { activity, roster, people, eligible };
  }

  private isOpen(activity: repo.ActivityFacts): boolean {
    return (
      activity.transportMode === "own" &&
      activity.status !== "cancelled" &&
      activity.startsAt > this.now()
    );
  }

  private requireOpen(activity: repo.ActivityFacts): void {
    if (activity.transportMode !== "own" || activity.status === "cancelled") {
      throw new DomainError("carpool_closed");
    }
    if (activity.startsAt <= this.now()) throw new DomainError("carpool_started");
  }

  private async ownOffer(
    tx: Tx,
    activityId: string,
    offerId: string,
    me: string,
  ): Promise<repo.OfferRow> {
    const offer = await repo.offerForUpdate(tx, offerId);
    if (offer?.activityId !== activityId) throw new DomainError("not_found");
    if (offer.driverPersonId !== me) throw new DomainError("not_allowed");
    return offer;
  }

  /** Books a seat in the car and settles the rule of two; returns the booking. */
  private async bookInto(
    tx: Tx,
    scope: Scope,
    all: readonly repo.OfferRow[],
    offer: repo.OfferRow,
    passenger: string,
    me: string,
    confirmBy: string | null,
  ): Promise<string> {
    if (offer.willingOnly) throw new DomainError("carpool_not_bookable");
    if (offer.driverPersonId === passenger) throw new DomainError("carpool_own_car");
    if (offer.bookings.length >= offer.seats) throw new DomainError("carpool_full");
    const taken = all.some(
      (o) =>
        o.direction === offer.direction &&
        o.bookings.some((b) => b.passengerPersonId === passenger),
    );
    if (taken) throw new DomainError("carpool_already_booked");
    const id = await repo.insertBooking(tx, {
      clubId: offer.clubId,
      offerId: offer.id,
      passengerPersonId: passenger,
      bookedByPersonId: me,
    });
    await audit.record(tx, {
      action: "carpool.booking.created",
      resourceType: "activity",
      resourceId: offer.activityId,
      changedFields: ["passenger_person_id"],
    });
    const booking: repo.BookingRow = {
      id,
      offerId: offer.id,
      passengerPersonId: passenger,
      bookedByPersonId: me,
      status: "held",
      confirmedByPersonId: null,
    };
    await this.settle(
      tx,
      scope,
      { ...offer, bookings: [...offer.bookings, booking] },
      confirmBy ? { bookingId: id, byPersonId: confirmBy } : undefined,
      me,
    );
    if (offer.driverPersonId !== me) {
      await this.notify(tx, scope.activity, me, {
        kind: "booked",
        driverPersonId: offer.driverPersonId,
        personIds: [offer.driverPersonId],
      });
    }
    return id;
  }

  /**
   * Applies the rule of two to the car's live seats; asks the guardians of
   * a seat that now waits (the caller is not asked).
   */
  private async settle(
    tx: Tx,
    scope: Scope,
    offer: repo.OfferRow,
    confirm?: { bookingId: string; byPersonId: string },
    actor: string | null = null,
  ): Promise<void> {
    const car: CarFacts = {
      driverPersonId: offer.driverPersonId,
      seats: offer.bookings.map((b) => ({
        bookingId: b.id,
        passengerPersonId: b.passengerPersonId,
        status: b.status === "pending_guardian" ? "pending_guardian" : "held",
        confirmedByPersonId: b.confirmedByPersonId,
      })),
      isChild: (p) => scope.people.isChild(p),
      guardiansOf: (p) => scope.people.guardiansOf(p),
    };
    for (const change of settleSeats(car, confirm)) {
      await repo.setBookingState(tx, change.bookingId, {
        status: change.status,
        confirmedBy: change.confirmedBy,
      });
      if (change.newlyPending) {
        const seat = offer.bookings.find((b) => b.id === change.bookingId)!;
        await this.notify(tx, scope.activity, actor, {
          kind: "confirm",
          driverPersonId: offer.driverPersonId,
          personIds: scope.people.guardiansOf(seat.passengerPersonId, "act_on_behalf"),
        });
      }
    }
  }

  private async notify(
    tx: Tx,
    activity: repo.ActivityFacts,
    actor: string | null,
    notice: Notice,
  ): Promise<void> {
    const personIds = [...new Set(notice.personIds)].filter((id) => id !== actor).slice(0, 50);
    if (personIds.length === 0) return;
    await outbox.publish(tx, "carpool.changed", {
      clubId: activity.clubId,
      kind: notice.kind,
      activityId: activity.id,
      driverPersonId: notice.driverPersonId,
      personIds,
    });
  }
}

/** Who booked the car's seats (else the passengers): told of its changes. */
function bookers(offer: repo.OfferRow): string[] {
  return offer.bookings.map((b) => b.bookedByPersonId ?? b.passengerPersonId);
}
