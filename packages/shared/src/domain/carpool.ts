// SPDX-License-Identifier: AGPL-3.0-only
// Car pooling (P2.5, ADR 0048): an activity's transport mode, cars offered
// with seats (or "willing to drive"), return trips, seats booked for oneself
// or a child, the guardian's confirmation when one adult would be alone with
// a single child not their own (the rule of two), "Mina samåkningar" and the
// group's statistics. People appear only as PersonSummary from the presenter
// (ADR 0022).

import { PersonSummarySchema } from "../auth/schemas.ts";
import { z } from "../zod.ts";

export const TRANSPORT_MODES = ["own", "shared"] as const;
export type TransportMode = (typeof TRANSPORT_MODES)[number];

export const CARPOOL_DIRECTIONS = ["out", "back"] as const;
export type CarpoolDirection = (typeof CARPOOL_DIRECTIONS)[number];

export const CARPOOL_BOOKING_STATUSES = ["held", "pending_guardian", "cancelled"] as const;
export type CarpoolBookingStatus = (typeof CARPOOL_BOOKING_STATUSES)[number];

/** A car has at most this many seats to offer. */
export const CARPOOL_MAX_SEATS = 8;
/** Without a guardian's choice or the country pack's: children book seats themselves from this age. */
export const CARPOOL_SELF_BOOKING_AGE = 13;

export const CarpoolActivityParamsSchema = z.object({ activityId: z.uuid() });
export const CarpoolOfferParamsSchema = z.object({ activityId: z.uuid(), offerId: z.uuid() });
export const CarpoolBookingParamsSchema = z.object({
  activityId: z.uuid(),
  offerId: z.uuid(),
  bookingId: z.uuid(),
});
export const CarpoolBookingIdParamsSchema = z.object({ bookingId: z.uuid() });

export const CarpoolBookingSchema = z
  .object({
    id: z.uuid(),
    /** None: the viewer may not see who rides (or a protected child). */
    passenger: PersonSummarySchema.nullable(),
    status: z.enum(CARPOOL_BOOKING_STATUSES),
    /** The viewer may cancel it (the passenger, who booked it, a guardian, the driver). */
    canCancel: z.boolean(),
    /** The viewer is a guardian who may confirm it (pending only). */
    canConfirm: z.boolean(),
  })
  .openapi("CarpoolBooking");
export type CarpoolBooking = z.infer<typeof CarpoolBookingSchema>;

export const CarpoolOfferSchema = z
  .object({
    id: z.uuid(),
    direction: z.enum(CARPOOL_DIRECTIONS),
    /** A return trip's outward car. */
    outwardOfferId: z.uuid().nullable(),
    /** None: hidden (protected identity). */
    driver: PersonSummarySchema.nullable(),
    /** The viewer drives it. */
    mine: z.boolean(),
    willingOnly: z.boolean(),
    seats: z.number().int(),
    freeSeats: z.number().int(),
    departurePlace: z.string().nullable(),
    /** The driver's note ("room for a kit bag", "pets have been in the car"). */
    note: z.string().nullable(),
    departureAt: z.iso.datetime().nullable(),
    /** The driver's correction, else the place's distance (km, one way). */
    distanceKm: z.number().nullable(),
    /** Seats booked; passengers named only for those who may see them. */
    bookings: z.array(CarpoolBookingSchema),
  })
  .openapi("CarpoolOffer");
export type CarpoolOffer = z.infer<typeof CarpoolOfferSchema>;

export const CarpoolSchema = z
  .object({
    activityId: z.uuid(),
    transportMode: z.enum(TRANSPORT_MODES).nullable(),
    /** The place's distance from the club's starting place (km). */
    distanceKm: z.number().nullable(),
    offers: z.array(CarpoolOfferSchema),
    /** The viewer may offer a car (an adult taking part, or a guardian of one). */
    canOffer: z.boolean(),
    /** Whom the viewer may book a seat for (themselves, their children). */
    canBookFor: z.array(PersonSummarySchema),
    /** For the activity's leaders: participants without a seat out, or null. */
    withoutRide: z.array(PersonSummarySchema).nullable(),
    /** How many without a seat out the leaders cannot see by name (protected). */
    withoutRideHidden: z.number().int(),
  })
  .openapi("Carpool");
export type Carpool = z.infer<typeof CarpoolSchema>;

/**
 * The car pools of a page of the schedule (P2.7c): per activity the caller
 * or a ward takes part in, the cars with seats (driver, departure, free
 * seats), whom the caller may book for, and their family's seats. For "Åk
 * med dit/hem" and the "Kommer" menu without opening the activity.
 */
export const CarpoolSummariesQuerySchema = z.object({
  /** Comma-separated activity IDs of the club (at most 60). */
  activityIds: z
    .string()
    .transform((v) => v.split(",").filter(Boolean))
    .pipe(z.array(z.uuid()).min(1).max(60)),
});
export const CarpoolSummarySchema = z
  .object({
    activityId: z.uuid(),
    open: z.boolean(),
    offers: z.array(
      z.object({
        id: z.uuid(),
        direction: z.enum(CARPOOL_DIRECTIONS),
        outwardOfferId: z.uuid().nullable(),
        driver: PersonSummarySchema.nullable(),
        mine: z.boolean(),
        freeSeats: z.number().int().min(0),
        departurePlace: z.string().nullable(),
        departureAt: z.iso.datetime({ offset: true }).nullable(),
      }),
    ),
    canBookFor: z.array(PersonSummarySchema),
    /** The caller's and their wards' seats. */
    bookings: z.array(
      z.object({
        id: z.uuid(),
        offerId: z.uuid(),
        direction: z.enum(CARPOOL_DIRECTIONS),
        passengerPersonId: z.uuid(),
        status: z.enum(CARPOOL_BOOKING_STATUSES),
        canCancel: z.boolean(),
      }),
    ),
  })
  .openapi("CarpoolSummary");
export type CarpoolSummary = z.infer<typeof CarpoolSummarySchema>;
export const CarpoolSummariesSchema = z
  .object({ items: z.array(CarpoolSummarySchema) })
  .openapi("CarpoolSummaries");
export type CarpoolSummaries = z.infer<typeof CarpoolSummariesSchema>;

export const CreateCarpoolOfferSchema = z
  .object({
    direction: z.enum(CARPOOL_DIRECTIONS).default("out"),
    willingOnly: z.boolean().default(false),
    seats: z.number().int().min(0).max(CARPOOL_MAX_SEATS).default(0),
    departurePlace: z.string().trim().max(200).nullish(),
    /** The driver's note ("room for a kit bag", "pets have been in the car"). */
    note: z.string().trim().max(300).nullish(),
    departureAt: z.iso.datetime({ offset: true }).nullish(),
    /** Also offer the return trip (same car, seats and note; edited on its own). */
    withReturn: z.boolean().default(false),
    /**
     * The return trip's own departure (P2.7c): never the outward trip's;
     * none when not given (the forms prefill the activity's place and end).
     */
    returnDeparturePlace: z.string().trim().max(200).nullish(),
    returnDepartureAt: z.iso.datetime({ offset: true }).nullish(),
  })
  .strict()
  .openapi("CreateCarpoolOffer");
export type CreateCarpoolOfferInput = z.input<typeof CreateCarpoolOfferSchema>;

export const UpdateCarpoolOfferSchema = z
  .object({
    willingOnly: z.boolean().optional(),
    seats: z.number().int().min(0).max(CARPOOL_MAX_SEATS).optional(),
    departurePlace: z.string().trim().max(200).nullish(),
    /** The driver's note ("room for a kit bag", "pets have been in the car"). */
    note: z.string().trim().max(300).nullish(),
    departureAt: z.iso.datetime({ offset: true }).nullish(),
    /** The distance driven (one way), corrected after the trip; null: the place's. */
    distanceKm: z.number().min(0).max(5000).nullish(),
  })
  .strict()
  .openapi("UpdateCarpoolOffer");
export type UpdateCarpoolOfferInput = z.input<typeof UpdateCarpoolOfferSchema>;

export const CarpoolOfferCreatedSchema = z
  .object({ id: z.uuid(), returnId: z.uuid().nullable() })
  .openapi("CarpoolOfferCreated");

export const BookCarpoolSeatSchema = z
  .object({
    passengerPersonId: z.uuid(),
    /** Also book the seat home in the same car's return trip. */
    alsoReturn: z.boolean().default(false),
    /**
     * A guardian confirms, having seen the driver's name, that the child may
     * be the only child with that adult (the rule of two).
     */
    confirmAlone: z.boolean().default(false),
  })
  .strict()
  .openapi("BookCarpoolSeat");
export type BookCarpoolSeatInput = z.input<typeof BookCarpoolSeatSchema>;

export const CarpoolBookedSchema = z
  .object({
    id: z.uuid(),
    status: z.enum(CARPOOL_BOOKING_STATUSES),
    returnId: z.uuid().nullable(),
  })
  .openapi("CarpoolBooked");

export const SetCarpoolAgeSchema = z
  .object({ age: z.number().int().min(7).max(18).nullable() })
  .strict()
  .openapi("SetCarpoolAge");
export type SetCarpoolAgeInput = z.infer<typeof SetCarpoolAgeSchema>;

export const CarpoolAgeSchema = z
  .object({
    /** The caller's own setting; null: the default. */
    age: z.number().int().nullable(),
    /** The country pack's age (the strictest of the child's clubs). */
    defaultAge: z.number().int(),
  })
  .openapi("CarpoolAge");
export type CarpoolAge = z.infer<typeof CarpoolAgeSchema>;

// --- "Mina samåkningar" -----------------------------------------------------------

export const MyCarpoolSchema = z
  .object({
    clubId: z.uuid(),
    clubName: z.string(),
    activityId: z.uuid(),
    activityTitle: z.string(),
    startsAt: z.iso.datetime(),
    offerId: z.uuid(),
    direction: z.enum(CARPOOL_DIRECTIONS),
    /** The viewer drives it. */
    driving: z.boolean(),
    /** A seat: whose (the viewer or a child) and its state. */
    bookingId: z.uuid().nullable(),
    passenger: PersonSummarySchema.nullable(),
    status: z.enum(CARPOOL_BOOKING_STATUSES).nullable(),
    /** The driver (for a seat); none for the viewer's own drives or when hidden. */
    driver: PersonSummarySchema.nullable(),
  })
  .openapi("MyCarpool");
export type MyCarpool = z.infer<typeof MyCarpoolSchema>;

export const MyCarpoolListSchema = z
  .object({
    /** Confirmations the viewer is asked for first, then the rest by time. */
    items: z.array(MyCarpoolSchema),
  })
  .openapi("MyCarpoolList");
export type MyCarpoolList = z.infer<typeof MyCarpoolListSchema>;

// --- Statistics and settings --------------------------------------------------------

export const CarpoolStatsQuerySchema = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
});
export type CarpoolStatsQuery = z.infer<typeof CarpoolStatsQuerySchema>;

export const CarpoolStatsSchema = z
  .object({
    groupId: z.uuid(),
    from: z.iso.date(),
    to: z.iso.date(),
    public: z.boolean(),
    rows: z.array(
      z.object({
        /** None: hidden (protected identity). */
        person: PersonSummarySchema.nullable(),
        drives: z.number().int(),
        distanceKm: z.number(),
        passengers: z.number().int(),
        rides: z.number().int(),
      }),
    ),
  })
  .openapi("CarpoolStats");
export type CarpoolStats = z.infer<typeof CarpoolStatsSchema>;

export const CarpoolSettingsSchema = z
  .object({ startLocationId: z.uuid().nullable() })
  .openapi("CarpoolSettings");
export type CarpoolSettings = z.infer<typeof CarpoolSettingsSchema>;

export const PutCarpoolSettingsSchema = z
  .object({ startLocationId: z.uuid().nullable() })
  .strict()
  .openapi("PutCarpoolSettings");
export type PutCarpoolSettingsInput = z.infer<typeof PutCarpoolSettingsSchema>;

export const DeleteCarpoolsQuerySchema = z.object({ before: z.iso.date() });

export const CarpoolsDeletedSchema = z
  .object({ offers: z.number().int() })
  .openapi("CarpoolsDeleted");

export const GroupCarpoolSettingsSchema = z
  .object({ statsPublic: z.boolean() })
  .openapi("GroupCarpoolSettings");

export const PutGroupCarpoolSettingsSchema = z
  .object({ statsPublic: z.boolean() })
  .strict()
  .openapi("PutGroupCarpoolSettings");
export type PutGroupCarpoolSettingsInput = z.infer<typeof PutGroupCarpoolSettingsSchema>;

export const CarpoolGroupParamsSchema = z.object({ clubId: z.uuid(), groupId: z.uuid() });
