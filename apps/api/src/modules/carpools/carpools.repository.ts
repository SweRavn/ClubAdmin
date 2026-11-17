// SPDX-License-Identifier: AGPL-3.0-only
// Car pools' queries (P2.5, ADR 0048). The module owns carpool_offers and
// carpool_bookings; it reads (never writes) the activity, its place and
// groups, the roster (rosterQuery of the activities module), people's birth
// dates and active guardianships, under the caller's tenant RLS. IDs only
// towards people.

import { sql, type Tx } from "@clubadmin/db";
import type { CarpoolBookingStatus, CarpoolDirection, TransportMode } from "@clubadmin/shared";

import { rosterQuery } from "../activities/index.ts";

const uuidArray = (ids: readonly string[]) => `{${ids.join(",")}}`;
const num = (v: string | number | null): number | null => (v === null ? null : Number(v));

export interface ActivityFacts {
  id: string;
  clubId: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
  transportMode: TransportMode | null;
  /** The place's distance (km), when at a club place that has one. */
  distanceKm: number | null;
  country: string;
}

/** The activity with what the car pool needs of it (null: not readable). */
export async function activityFacts(tx: Tx, activityId: string): Promise<ActivityFacts | null> {
  const { rows } = await tx.execute<{
    id: string;
    club_id: string;
    title: string;
    starts_at: string | Date;
    ends_at: string | Date;
    status: string;
    transport_mode: TransportMode | null;
    distance_km: string | null;
    country: string;
  }>(sql`
    SELECT a.id, a.club_id, a.title, a.starts_at, a.ends_at, a.status, a.transport_mode,
      l.distance_km, c.country
    FROM public.activities a
    JOIN public.clubs c ON c.id = a.club_id
    LEFT JOIN public.locations l ON l.club_id = a.club_id AND l.id = a.location_id
    WHERE a.id = ${activityId}::uuid`);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    clubId: r.club_id,
    title: r.title,
    startsAt: new Date(r.starts_at),
    endsAt: new Date(r.ends_at),
    status: r.status,
    transportMode: r.transport_mode,
    distanceKm: num(r.distance_km),
    country: r.country,
  };
}

export interface BookingRow {
  id: string;
  offerId: string;
  passengerPersonId: string;
  bookedByPersonId: string | null;
  status: CarpoolBookingStatus;
  confirmedByPersonId: string | null;
}

export interface OfferRow {
  id: string;
  clubId: string;
  activityId: string;
  driverPersonId: string;
  direction: CarpoolDirection;
  outwardOfferId: string | null;
  willingOnly: boolean;
  seats: number;
  departurePlace: string | null;
  note: string | null;
  departureAt: Date | null;
  distanceKm: number | null;
  /** Its live (not cancelled) bookings, oldest first. */
  bookings: BookingRow[];
}

type OfferDb = {
  id: string;
  club_id: string;
  activity_id: string;
  driver_person_id: string;
  direction: CarpoolDirection;
  outward_offer_id: string | null;
  willing_only: boolean;
  seats: number;
  departure_place: string | null;
  note: string | null;
  departure_at: string | Date | null;
  distance_km: string | null;
  bookings: {
    id: string;
    passenger_person_id: string;
    booked_by_person_id: string | null;
    status: CarpoolBookingStatus;
    confirmed_by_person_id: string | null;
  }[];
};

const toOffer = (r: OfferDb): OfferRow => ({
  id: r.id,
  clubId: r.club_id,
  activityId: r.activity_id,
  driverPersonId: r.driver_person_id,
  direction: r.direction,
  outwardOfferId: r.outward_offer_id,
  willingOnly: r.willing_only,
  seats: r.seats,
  departurePlace: r.departure_place,
  note: r.note,
  departureAt: r.departure_at === null ? null : new Date(r.departure_at),
  distanceKm: num(r.distance_km),
  bookings: r.bookings.map((b) => ({
    id: b.id,
    offerId: r.id,
    passengerPersonId: b.passenger_person_id,
    bookedByPersonId: b.booked_by_person_id,
    status: b.status,
    confirmedByPersonId: b.confirmed_by_person_id,
  })),
});

const OFFER_SELECT = sql`
  SELECT o.id, o.club_id, o.activity_id, o.driver_person_id, o.direction, o.outward_offer_id,
    o.willing_only, o.seats, o.departure_place, o.note, o.departure_at, o.distance_km,
    coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', b.id, 'passenger_person_id', b.passenger_person_id,
          'booked_by_person_id', b.booked_by_person_id, 'status', b.status,
          'confirmed_by_person_id', b.confirmed_by_person_id) ORDER BY b.created_at, b.id)
      FROM public.carpool_bookings b WHERE b.offer_id = o.id AND b.status <> 'cancelled'), '[]') AS bookings
  FROM public.carpool_offers o`;

/** The activity's cars, outward first, oldest first. */
export async function offers(tx: Tx, activityId: string): Promise<OfferRow[]> {
  const { rows } = await tx.execute<OfferDb>(sql`
    ${OFFER_SELECT}
    WHERE o.activity_id = ${activityId}::uuid
    ORDER BY o.direction DESC, o.id`);
  return rows.map(toOffer);
}

/** One car, locked for a change of its seats. */
export async function offerForUpdate(tx: Tx, offerId: string): Promise<OfferRow | null> {
  await tx.execute(sql`SELECT 1 FROM public.carpool_offers WHERE id = ${offerId}::uuid FOR UPDATE`);
  const { rows } = await tx.execute<OfferDb>(sql`${OFFER_SELECT} WHERE o.id = ${offerId}::uuid`);
  return rows[0] ? toOffer(rows[0]) : null;
}

/** The activity locked against concurrent bookings (one booking at a time per car pool). */
export async function lockActivity(tx: Tx, activityId: string): Promise<void> {
  await tx.execute(
    sql`SELECT 1 FROM public.activities WHERE id = ${activityId}::uuid FOR NO KEY UPDATE`,
  );
}

export interface PersonFacts {
  personId: string;
  birthDate: string | null;
  /** Active guardians, with their rights and self-booking age (null: the pack's). */
  guardians: { personId: string; rights: string[]; carpoolAge: number | null }[];
}

/** Birth dates and active guardians of these people (club members, under RLS). */
export async function personFacts(
  tx: Tx,
  personIds: readonly string[],
): Promise<Map<string, PersonFacts>> {
  if (personIds.length === 0) return new Map();
  const { rows } = await tx.execute<{
    id: string;
    birth_date: string | null;
    guardians: { personId: string; rights: string[]; carpoolAge: number | null }[];
  }>(sql`
    SELECT p.id, p.birth_date::text,
      coalesce((SELECT jsonb_agg(jsonb_build_object('personId', g.guardian_person_id,
          'rights', g.rights, 'carpoolAge', g.carpool_self_booking_age))
        FROM public.guardianships g
        WHERE g.ward_person_id = p.id AND g.status = 'active' AND g.valid_to IS NULL), '[]') AS guardians
    FROM public.people p
    WHERE p.id = ANY (${uuidArray([...new Set(personIds)])}::uuid[])`);
  return new Map(
    rows.map((r) => [r.id, { personId: r.id, birthDate: r.birth_date, guardians: r.guardians }]),
  );
}

export interface RosterEntry {
  personId: string;
  role: "participant" | "leader";
}

/** Who takes part (participants, leaders) on the activity's start. */
export async function roster(tx: Tx, activityId: string): Promise<RosterEntry[]> {
  const { rows } = await tx.execute<{ person_id: string; role: "participant" | "leader" }>(
    sql`SELECT r.person_id, r.role FROM (${rosterQuery([activityId])}) r`,
  );
  return rows.map((r) => ({ personId: r.person_id, role: r.role }));
}

export async function insertOffer(
  tx: Tx,
  values: {
    clubId: string;
    activityId: string;
    driverPersonId: string;
    direction: CarpoolDirection;
    outwardOfferId: string | null;
    willingOnly: boolean;
    seats: number;
    departurePlace: string | null;
    note: string | null;
    departureAt: Date | null;
  },
): Promise<string> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO public.carpool_offers (club_id, activity_id, driver_person_id, direction,
      outward_offer_id, willing_only, seats, departure_place, note, departure_at)
    VALUES (${values.clubId}::uuid, ${values.activityId}::uuid, ${values.driverPersonId}::uuid,
      ${values.direction}, ${values.outwardOfferId}::uuid, ${values.willingOnly}, ${values.seats},
      ${values.departurePlace}, ${values.note}, ${values.departureAt})
    RETURNING id`);
  return rows[0]!.id;
}

export async function updateOffer(
  tx: Tx,
  offerId: string,
  values: {
    willingOnly: boolean;
    seats: number;
    departurePlace: string | null;
    note: string | null;
    departureAt: Date | null;
    distanceKm: number | null;
  },
): Promise<void> {
  await tx.execute(sql`
    UPDATE public.carpool_offers SET willing_only = ${values.willingOnly}, seats = ${values.seats},
      departure_place = ${values.departurePlace}, note = ${values.note}, departure_at = ${values.departureAt},
      distance_km = ${values.distanceKm}
    WHERE id = ${offerId}::uuid`);
}

export async function deleteOffer(tx: Tx, offerId: string): Promise<void> {
  await tx.execute(sql`DELETE FROM public.carpool_offers WHERE id = ${offerId}::uuid`);
}

export async function insertBooking(
  tx: Tx,
  values: {
    clubId: string;
    offerId: string;
    passengerPersonId: string;
    bookedByPersonId: string;
  },
): Promise<string> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    INSERT INTO public.carpool_bookings (club_id, offer_id, passenger_person_id, booked_by_person_id)
    VALUES (${values.clubId}::uuid, ${values.offerId}::uuid, ${values.passengerPersonId}::uuid,
      ${values.bookedByPersonId}::uuid)
    RETURNING id`);
  return rows[0]!.id;
}

/** Sets a live booking's state (the rule of two), with or without a confirmation. */
export async function setBookingState(
  tx: Tx,
  bookingId: string,
  state: { status: "held" | "pending_guardian"; confirmedBy: string | null },
): Promise<void> {
  await tx.execute(sql`
    UPDATE public.carpool_bookings SET status = ${state.status},
      confirmed_by_person_id = ${state.confirmedBy}::uuid,
      confirmed_at = CASE WHEN ${state.confirmedBy}::uuid IS NULL THEN NULL
        ELSE coalesce(confirmed_at, now()) END
    WHERE id = ${bookingId}::uuid AND status <> 'cancelled'`);
}

export async function cancelBooking(tx: Tx, bookingId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    UPDATE public.carpool_bookings SET status = 'cancelled', cancelled_at = now(),
      confirmed_by_person_id = NULL, confirmed_at = NULL
    WHERE id = ${bookingId}::uuid AND status <> 'cancelled'
    RETURNING id`);
  return rows.length > 0;
}

/** A live booking with its car's activity (null: none). */
export async function booking(
  tx: Tx,
  bookingId: string,
): Promise<(BookingRow & { activityId: string; driverPersonId: string }) | null> {
  const { rows } = await tx.execute<{
    id: string;
    offer_id: string;
    passenger_person_id: string;
    booked_by_person_id: string | null;
    status: CarpoolBookingStatus;
    confirmed_by_person_id: string | null;
    activity_id: string;
    driver_person_id: string;
  }>(sql`
    SELECT b.id, b.offer_id, b.passenger_person_id, b.booked_by_person_id, b.status,
      b.confirmed_by_person_id, o.activity_id, o.driver_person_id
    FROM public.carpool_bookings b JOIN public.carpool_offers o ON o.id = b.offer_id
    WHERE b.id = ${bookingId}::uuid AND b.status <> 'cancelled'`);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    offerId: r.offer_id,
    passengerPersonId: r.passenger_person_id,
    bookedByPersonId: r.booked_by_person_id,
    status: r.status,
    confirmedByPersonId: r.confirmed_by_person_id,
    activityId: r.activity_id,
    driverPersonId: r.driver_person_id,
  };
}

// --- "Mina samåkningar" -------------------------------------------------------------

export interface MyCarpoolRow {
  clubId: string;
  clubName: string;
  activityId: string;
  activityTitle: string;
  startsAt: Date;
  offerId: string;
  direction: CarpoolDirection;
  driverPersonId: string;
  bookingId: string | null;
  passengerPersonId: string | null;
  status: CarpoolBookingStatus | null;
}

/** The caller's drives and their own and wards' seats, across clubs (app.my_carpools). */
export async function myCarpools(tx: Tx, limit: number): Promise<MyCarpoolRow[]> {
  const { rows } = await tx.execute<{
    club_id: string;
    club_name: string;
    activity_id: string;
    activity_title: string;
    starts_at: string | Date;
    offer_id: string;
    direction: CarpoolDirection;
    driver_person_id: string;
    booking_id: string | null;
    passenger_person_id: string | null;
    status: CarpoolBookingStatus | null;
  }>(sql`SELECT * FROM app.my_carpools(${limit})`);
  return rows.map((r) => ({
    clubId: r.club_id,
    clubName: r.club_name,
    activityId: r.activity_id,
    activityTitle: r.activity_title,
    startsAt: new Date(r.starts_at),
    offerId: r.offer_id,
    direction: r.direction,
    driverPersonId: r.driver_person_id,
    bookingId: r.booking_id,
    passengerPersonId: r.passenger_person_id,
    status: r.status,
  }));
}

/** The club of one of the caller's wards' bookings (app.ward_booking_club). */
export async function wardBookingClub(tx: Tx, bookingId: string): Promise<string | null> {
  const { rows } = await tx.execute<{ club_id: string | null }>(
    sql`SELECT app.ward_booking_club(${bookingId}::uuid) AS club_id`,
  );
  return rows[0]?.club_id ?? null;
}

// --- Statistics, settings, deletion ------------------------------------------------

export interface StatsRow {
  personId: string;
  drives: number;
  distanceKm: number;
  passengers: number;
  rides: number;
}

/**
 * Per person, for the group's activities that started in [from, to) and are
 * not cancelled: drives (cars with seats), their distance (the driver's
 * correction, else the place's), passengers carried and seats taken. From
 * the group's calendar entries (schedule_entries by group and start).
 */
export async function stats(
  tx: Tx,
  groupId: string,
  range: { from: Date; to: Date },
): Promise<StatsRow[]> {
  const { rows } = await tx.execute<{
    person_id: string;
    drives: number;
    distance_km: string;
    passengers: number;
    rides: number;
  }>(sql`
    WITH acts AS (
      SELECT se.activity_id FROM public.schedule_entries se
      WHERE se.group_id = ${groupId}::uuid AND se.starts_at >= ${range.from} AND se.starts_at < ${range.to}
        AND se.status <> 'cancelled'
    ), cars AS (
      SELECT o.id, o.driver_person_id,
        coalesce(o.distance_km, (SELECT l.distance_km FROM public.activities a
          JOIN public.locations l ON l.club_id = a.club_id AND l.id = a.location_id
          WHERE a.id = o.activity_id), 0) AS km,
        (SELECT count(*) FROM public.carpool_bookings b
         WHERE b.offer_id = o.id AND b.status <> 'cancelled')::int AS carried
      FROM acts JOIN public.carpool_offers o ON o.activity_id = acts.activity_id
      WHERE NOT o.willing_only
    ), per AS (
      SELECT c.driver_person_id AS person_id, 1 AS drives, c.km, c.carried AS passengers, 0 AS rides
      FROM cars c
      UNION ALL
      SELECT b.passenger_person_id, 0, 0, 0, 1
      FROM cars c JOIN public.carpool_bookings b ON b.offer_id = c.id AND b.status <> 'cancelled'
    )
    SELECT person_id, sum(drives)::int AS drives, sum(km)::text AS distance_km,
      sum(passengers)::int AS passengers, sum(rides)::int AS rides
    FROM per GROUP BY person_id
    ORDER BY sum(drives) DESC, sum(km) DESC, person_id`);
  return rows.map((r) => ({
    personId: r.person_id,
    drives: r.drives,
    distanceKm: Number(r.distance_km),
    passengers: r.passengers,
    rides: r.rides,
  }));
}

/** The group's "statistics public" setting (the groups module's column, read only). */
export async function statsPublic(tx: Tx, groupId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ public: boolean }>(
    sql`SELECT carpool_stats_public AS public FROM public.groups WHERE id = ${groupId}::uuid`,
  );
  return rows[0]?.public ?? false;
}

/** Deletes the club's cars (and their bookings) of activities that started before the date. */
export async function deleteBefore(tx: Tx, clubId: string, before: Date): Promise<number> {
  const { rows } = await tx.execute<{ n: number }>(sql`
    WITH gone AS (
      DELETE FROM public.carpool_offers o USING public.activities a
      WHERE o.club_id = ${clubId}::uuid AND a.id = o.activity_id AND a.starts_at < ${before}
      RETURNING o.id)
    SELECT count(*)::int AS n FROM gone`);
  return rows[0]?.n ?? 0;
}

/**
 * Sets the group's "statistics public" (a car-pool setting kept on the
 * group's row; only this module writes it). False: not the club's group.
 */
export async function setStatsPublic(tx: Tx, groupId: string, value: boolean): Promise<boolean> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    UPDATE public.groups SET carpool_stats_public = ${value}
    WHERE id = ${groupId}::uuid RETURNING id`);
  return rows.length > 0;
}

/** The club's starting place for distances (a car-pool setting on the club's row). */
export async function startLocation(tx: Tx, clubId: string): Promise<string | null> {
  const { rows } = await tx.execute<{ id: string | null }>(
    sql`SELECT carpool_start_location_id AS id FROM public.clubs WHERE id = ${clubId}::uuid`,
  );
  return rows[0]?.id ?? null;
}

export async function setStartLocation(
  tx: Tx,
  clubId: string,
  locationId: string | null,
): Promise<void> {
  await tx.execute(sql`
    UPDATE public.clubs SET carpool_start_location_id = ${locationId}::uuid
    WHERE id = ${clubId}::uuid`);
}

/** Whether the place is the club's and not archived. */
export async function liveLocation(tx: Tx, clubId: string, locationId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ ok: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM public.locations l
      WHERE l.club_id = ${clubId}::uuid AND l.id = ${locationId}::uuid AND l.archived_at IS NULL) AS ok`);
  return rows[0]?.ok ?? false;
}
