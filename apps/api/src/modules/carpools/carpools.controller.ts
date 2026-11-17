// SPDX-License-Identifier: AGPL-3.0-only
// Car pooling (P2.5 part A, ADR 0048): an activity's car pool, offers and
// bookings, a guardian's confirmation, "Mina samåkningar", the group's
// statistics and the club's settings. Who rides with whom is personal data
// about children: passengers are named only to the car's driver and
// passengers, their guardians and the activity's leaders, and a protected
// passenger only to the driver and their own family (ADR 0022). People
// always go through the PersonPresenter.

import {
  type BookCarpoolSeatInput,
  BookCarpoolSeatSchema,
  type Carpool,
  CarpoolActivityParamsSchema,
  CarpoolBookedSchema,
  CarpoolBookingIdParamsSchema,
  CarpoolBookingParamsSchema,
  CarpoolGroupParamsSchema,
  CarpoolOfferCreatedSchema,
  CarpoolOfferParamsSchema,
  CarpoolSchema,
  CarpoolsDeletedSchema,
  type CarpoolSettings,
  CarpoolSettingsSchema,
  type CarpoolStats,
  type CarpoolStatsQuery,
  CarpoolStatsQuerySchema,
  CarpoolStatsSchema,
  ClubParamsSchema,
  type CreateCarpoolOfferInput,
  CreateCarpoolOfferSchema,
  DeleteCarpoolsQuerySchema,
  GroupCarpoolSettingsSchema,
  type MyCarpoolList,
  MyCarpoolListSchema,
  type PersonSummary,
  type PutCarpoolSettingsInput,
  PutCarpoolSettingsSchema,
  type PutGroupCarpoolSettingsInput,
  PutGroupCarpoolSettingsSchema,
  type SetCarpoolAgeInput,
  SetCarpoolAgeSchema,
  type UpdateCarpoolOfferInput,
  UpdateCarpoolOfferSchema,
  WardParamsSchema,
  z,
} from "@clubadmin/shared";
import { Body, Controller, Param, Query } from "@nestjs/common";

import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  CurrentAuthorization,
  permits,
  PersonPresenter,
  type RequestAuthorization,
  resourceOf,
  tenantContext,
} from "../authorization/index.ts";
import { PeopleService } from "../people/index.ts";
import { CarpoolsService } from "./carpools.service.ts";

const TAGS = ["carpools"];

@Controller()
export class CarpoolsController {
  private readonly carpools: CarpoolsService;
  private readonly people: PeopleService;
  private readonly presenter: PersonPresenter;

  constructor(carpools: CarpoolsService, people: PeopleService, presenter: PersonPresenter) {
    this.carpools = carpools;
    this.people = people;
    this.presenter = presenter;
  }

  /** The people the caller may see among these, in one club. */
  private async persons(
    authz: RequestAuthorization,
    clubId: string,
    ids: readonly string[],
    alsoVisible?: ReadonlySet<string>,
  ): Promise<Map<string, PersonSummary>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.people.summaries(tenantContext(authz, clubId), unique);
    const shown = await this.presenter.present(
      authz,
      clubId,
      rows,
      alsoVisible ? { alsoVisible } : {},
    );
    return new Map(shown.map((p) => [p.id, p]));
  }

  // --- An activity's car pool -------------------------------------------------------

  @Endpoint({
    method: "GET",
    path: "activities/:activityId/carpool",
    summary: "The activity's car pool: cars, free seats, whom the caller may book for",
    tags: TAGS,
    access: { permission: "activity.read", resource: "activity" },
    request: { params: CarpoolActivityParamsSchema },
    response: CarpoolSchema,
  })
  async carpool(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { activityId: string },
  ): Promise<Carpool> {
    const activity = resourceOf(authz, "activity");
    const me = authz.actor.personId;
    const leader = permits(authz.actor, "activity.manage", activity);
    const view = await this.carpools.carpool(
      tenantContext(authz, activity.clubId),
      params.activityId,
    );
    // Passengers are named to the car's driver and passengers, their families and leaders.
    const seesPassengers = (o: (typeof view.offers)[number]) =>
      leader || o.driverPersonId === me || o.bookings.some((b) => view.family(b.passengerPersonId));
    const mine = view.offers.filter((o) => o.driverPersonId === me);
    const persons = await this.persons(
      authz,
      activity.clubId,
      [
        ...view.offers.map((o) => o.driverPersonId),
        ...view.offers
          .filter(seesPassengers)
          .flatMap((o) => o.bookings.map((b) => b.passengerPersonId)),
        ...view.bookFor,
        ...(leader ? view.withoutRide : []),
      ],
      new Set(mine.flatMap((o) => o.bookings.map((b) => b.passengerPersonId))),
    );
    const withoutRide = leader
      ? view.withoutRide.flatMap((id) => (persons.has(id) ? [persons.get(id)!] : []))
      : null;
    return {
      activityId: view.activity.id,
      transportMode: view.activity.transportMode,
      distanceKm: view.activity.distanceKm,
      offers: view.offers.map((o) => ({
        id: o.id,
        direction: o.direction,
        outwardOfferId: o.outwardOfferId,
        driver: persons.get(o.driverPersonId) ?? null,
        mine: o.driverPersonId === me,
        willingOnly: o.willingOnly,
        seats: o.seats,
        freeSeats: Math.max(0, o.seats - o.bookings.length),
        departurePlace: o.departurePlace,
        note: o.note,
        departureAt: o.departureAt?.toISOString() ?? null,
        distanceKm: o.distanceKm ?? view.activity.distanceKm,
        bookings: o.bookings.map((b) => {
          const p = seesPassengers(o) ? persons.get(b.passengerPersonId) : undefined;
          // A protected passenger: the driver and their own family only.
          const shown =
            p && (!p.protected || o.driverPersonId === me || view.family(b.passengerPersonId));
          return {
            id: b.id,
            passenger: shown ? p : null,
            status: b.status,
            canCancel: view.canCancel(b, o.driverPersonId),
            canConfirm: view.canConfirm(b),
          };
        }),
      })),
      canOffer: view.canOffer,
      canBookFor: view.bookFor.flatMap((id) => (persons.has(id) ? [persons.get(id)!] : [])),
      withoutRide,
      withoutRideHidden: leader ? view.withoutRide.length - (withoutRide?.length ?? 0) : 0,
    };
  }

  @Endpoint({
    method: "POST",
    path: "activities/:activityId/carpool/offers",
    summary: "Offer a car (or to drive if needed), with the return trip if asked",
    tags: TAGS,
    access: { permission: "activity.read", resource: "activity" },
    request: { params: CarpoolActivityParamsSchema, body: CreateCarpoolOfferSchema },
    response: CarpoolOfferCreatedSchema,
    status: 201,
  })
  createOffer(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { activityId: string },
    @Body() body: CreateCarpoolOfferInput,
  ): Promise<{ id: string; returnId: string | null }> {
    const activity = resourceOf(authz, "activity");
    return this.carpools.createOffer(
      tenantContext(authz, activity.clubId),
      params.activityId,
      body,
    );
  }

  @Endpoint({
    method: "PATCH",
    path: "activities/:activityId/carpool/offers/:offerId",
    summary: "Change one's car (after the trip: the distance driven only)",
    tags: TAGS,
    access: { permission: "activity.read", resource: "activity" },
    request: { params: CarpoolOfferParamsSchema, body: UpdateCarpoolOfferSchema },
    response: z.null(),
    status: 204,
  })
  async updateOffer(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { activityId: string; offerId: string },
    @Body() body: UpdateCarpoolOfferInput,
  ): Promise<null> {
    const activity = resourceOf(authz, "activity");
    await this.carpools.updateOffer(
      tenantContext(authz, activity.clubId),
      params.activityId,
      params.offerId,
      body,
    );
    return null;
  }

  @Endpoint({
    method: "DELETE",
    path: "activities/:activityId/carpool/offers/:offerId",
    summary: "Remove one's car before the trip (its seats go with it)",
    tags: TAGS,
    access: { permission: "activity.read", resource: "activity" },
    request: { params: CarpoolOfferParamsSchema },
    response: z.null(),
    status: 204,
  })
  async deleteOffer(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { activityId: string; offerId: string },
  ): Promise<null> {
    const activity = resourceOf(authz, "activity");
    await this.carpools.deleteOffer(
      tenantContext(authz, activity.clubId),
      params.activityId,
      params.offerId,
    );
    return null;
  }

  @Endpoint({
    method: "POST",
    path: "activities/:activityId/carpool/offers/:offerId/bookings",
    summary: "Book a seat for oneself or one's child (and the seat home)",
    tags: TAGS,
    access: { permission: "activity.read", resource: "activity" },
    request: { params: CarpoolOfferParamsSchema, body: BookCarpoolSeatSchema },
    response: CarpoolBookedSchema,
    status: 201,
  })
  book(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { activityId: string; offerId: string },
    @Body() body: BookCarpoolSeatInput,
  ): Promise<z.infer<typeof CarpoolBookedSchema>> {
    const activity = resourceOf(authz, "activity");
    return this.carpools.book(
      tenantContext(authz, activity.clubId),
      params.activityId,
      params.offerId,
      body,
    );
  }

  @Endpoint({
    method: "DELETE",
    path: "activities/:activityId/carpool/offers/:offerId/bookings/:bookingId",
    summary: "Cancel a seat (the passenger, who booked it, a guardian or the driver)",
    tags: TAGS,
    access: { permission: "activity.read", resource: "activity" },
    request: { params: CarpoolBookingParamsSchema },
    response: z.null(),
    status: 204,
  })
  async cancelBooking(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { activityId: string; offerId: string; bookingId: string },
  ): Promise<null> {
    const activity = resourceOf(authz, "activity");
    await this.carpools.cancelBooking(
      tenantContext(authz, activity.clubId),
      params.activityId,
      params.offerId,
      params.bookingId,
    );
    return null;
  }

  // --- The caller's own -------------------------------------------------------------

  @Endpoint({
    method: "POST",
    path: "me/carpool-bookings/:bookingId/confirm",
    summary: "Confirm that one's child may be the only child with that driver",
    tags: TAGS,
    access: { authenticated: true },
    request: { params: CarpoolBookingIdParamsSchema },
    response: z.null(),
    status: 204,
  })
  async confirm(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { bookingId: string },
  ): Promise<null> {
    await this.carpools.confirm(authz.context, params.bookingId);
    return null;
  }

  @Endpoint({
    method: "PUT",
    path: "me/wards/:personId/carpool-age",
    summary: "From which age one's child books car-pool seats themselves",
    tags: TAGS,
    access: { authenticated: true },
    request: { params: WardParamsSchema, body: SetCarpoolAgeSchema },
    response: z.null(),
    status: 204,
  })
  async setAge(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { personId: string },
    @Body() body: SetCarpoolAgeInput,
  ): Promise<null> {
    await this.carpools.setSelfBookingAge(authz.context, params.personId, body.age);
    return null;
  }

  @Endpoint({
    method: "GET",
    path: "me/carpools",
    summary: "Mina samåkningar: my drives and my own and my children's seats",
    tags: TAGS,
    access: { authenticated: true },
    request: {},
    response: MyCarpoolListSchema,
  })
  async myCarpools(@CurrentAuthorization() authz: RequestAuthorization): Promise<MyCarpoolList> {
    const me = authz.actor.personId;
    const rows = await this.carpools.myCarpools(authz.context);
    const byClub = new Map<string, string[]>();
    for (const r of rows) {
      const ids = byClub.get(r.clubId) ?? [];
      ids.push(r.driverPersonId, ...(r.passengerPersonId ? [r.passengerPersonId] : []));
      byClub.set(r.clubId, ids);
    }
    const persons = new Map<string, PersonSummary>();
    for (const [clubId, ids] of byClub) {
      for (const [id, p] of await this.persons(authz, clubId, ids)) {
        persons.set(`${clubId}:${id}`, p);
      }
    }
    const asked = (r: (typeof rows)[number]) =>
      r.status === "pending_guardian" && r.passengerPersonId !== me;
    const items = rows.map((r) => {
      const driving = r.bookingId === null && r.driverPersonId === me;
      return {
        clubId: r.clubId,
        clubName: r.clubName,
        activityId: r.activityId,
        activityTitle: r.activityTitle,
        startsAt: r.startsAt.toISOString(),
        offerId: r.offerId,
        direction: r.direction,
        driving,
        bookingId: r.bookingId,
        passenger: r.passengerPersonId
          ? (persons.get(`${r.clubId}:${r.passengerPersonId}`) ?? null)
          : null,
        status: r.status,
        driver: driving ? null : (persons.get(`${r.clubId}:${r.driverPersonId}`) ?? null),
      };
    });
    // Confirmations the caller is asked for first (a stable sort keeps the time order).
    const order = new Map(rows.map((r, i) => [r, i]));
    const sorted = rows
      .map((r, i) => ({ r, item: items[i]! }))
      .sort((a, b) => Number(asked(b.r)) - Number(asked(a.r)) || order.get(a.r)! - order.get(b.r)!);
    return { items: sorted.map((s) => s.item) };
  }

  // --- The group's statistics and setting ---------------------------------------------

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/groups/:groupId/carpool-stats",
    summary: "Drives, distance and passengers per person (leaders, attesters; members when public)",
    tags: TAGS,
    access: { permission: "group.activities.read", resource: "group" },
    request: { params: CarpoolGroupParamsSchema, query: CarpoolStatsQuerySchema },
    response: CarpoolStatsSchema,
  })
  async stats(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; groupId: string },
    @Query() query: CarpoolStatsQuery,
  ): Promise<CarpoolStats> {
    const group = resourceOf(authz, "group");
    // Leaders and attesters (P2.5 part B) see every row.
    const leader =
      permits(authz.actor, "group.activities.manage", group) ||
      authz.actor.ownsGroup(group) ||
      permits(authz.actor, "group.expenses.attest", group);
    const result = await this.carpools.stats(
      tenantContext(authz, group.clubId),
      group.groupId,
      query,
    );
    // Without being a leader or the setting, the caller sees their own and their children's rows.
    const me = authz.actor.personId;
    const rows =
      leader || result.public
        ? result.rows
        : result.rows.filter((r) => r.personId === me || authz.actor.isGuardianOf(r.personId));
    const persons = await this.persons(
      authz,
      group.clubId,
      rows.map((r) => r.personId),
    );
    return {
      groupId: params.groupId,
      from: query.from,
      to: query.to,
      public: result.public,
      rows: rows.map((r) => ({
        person: persons.get(r.personId) ?? null,
        drives: r.drives,
        distanceKm: Math.round(r.distanceKm * 10) / 10,
        passengers: r.passengers,
        rides: r.rides,
      })),
    };
  }

  @Endpoint({
    method: "PUT",
    path: "clubs/:clubId/groups/:groupId/carpool-settings",
    summary: "Make the group's car-pool statistics public in the group (its leaders)",
    tags: TAGS,
    access: { permission: "group.activities.manage", resource: "group" },
    request: { params: CarpoolGroupParamsSchema, body: PutGroupCarpoolSettingsSchema },
    response: GroupCarpoolSettingsSchema,
  })
  async putGroupSettings(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: PutGroupCarpoolSettingsInput,
  ): Promise<{ statsPublic: boolean }> {
    const group = resourceOf(authz, "group");
    await this.carpools.setStatsPublic(
      tenantContext(authz, group.clubId),
      group.groupId,
      body.statsPublic,
    );
    return { statsPublic: body.statsPublic };
  }

  // --- The club's settings and old data ------------------------------------------------

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/carpool-settings",
    summary: "The club's car-pool settings: the starting place of distances",
    tags: TAGS,
    access: { permission: "club.carpools.manage", resource: "club" },
    request: { params: ClubParamsSchema },
    response: CarpoolSettingsSchema,
  })
  settings(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string },
  ): Promise<CarpoolSettings> {
    return this.carpools.settings(tenantContext(authz, params.clubId));
  }

  @Endpoint({
    method: "PUT",
    path: "clubs/:clubId/carpool-settings",
    summary: "Set the starting place distances are measured from",
    tags: TAGS,
    access: { permission: "club.carpools.manage", resource: "club" },
    request: { params: ClubParamsSchema, body: PutCarpoolSettingsSchema },
    response: CarpoolSettingsSchema,
  })
  async putSettings(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string },
    @Body() body: PutCarpoolSettingsInput,
  ): Promise<CarpoolSettings> {
    await this.carpools.setSettings(tenantContext(authz, params.clubId), body.startLocationId);
    return { startLocationId: body.startLocationId };
  }

  @Endpoint({
    method: "DELETE",
    path: "clubs/:clubId/carpools",
    summary: "Delete the club's car pools of activities before a date",
    tags: TAGS,
    access: { permission: "club.carpools.manage", resource: "club" },
    request: { params: ClubParamsSchema, query: DeleteCarpoolsQuerySchema },
    response: CarpoolsDeletedSchema,
  })
  async deleteBefore(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string },
    @Query() query: { before: string },
  ): Promise<{ offers: number }> {
    return {
      offers: await this.carpools.deleteBefore(tenantContext(authz, params.clubId), query.before),
    };
  }
}
