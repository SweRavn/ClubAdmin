// SPDX-License-Identifier: AGPL-3.0-only
// Waiting lists of groups (P1.10b, ADR 0043): applying, the owner's list and
// decisions (offer, admit, remove, priority), the applicant's answers
// (accept, decline, withdraw), the club managers' view and the groups open
// for applications in the club search.

import { PersonSummarySchema } from "../auth/schemas.ts";
import { z } from "../zod.ts";
import {
  ADMISSION_MODES,
  GENDER_CATEGORIES,
  GROUP_KINDS,
  WAITLIST_CLOSED_REASONS,
  WAITLIST_PRIORITY_REASONS,
  WAITLIST_REMOVAL_REASONS,
  WAITLIST_STATUSES,
} from "./core.ts";

/** Notes on an entry: for the group's owners (applicant) or the owners only (owner). */
export const WAITLIST_NOTE_MAX = 500;

export const WaitlistEntryParamsSchema = z.object({ groupId: z.uuid(), entryId: z.uuid() });
export const MyWaitlistEntryParamsSchema = z.object({ entryId: z.uuid() });

export const ApplyWaitlistSchema = z
  .object({
    /** The caller, or a ward the caller acts for. */
    personId: z.uuid(),
    /** For the group's owners; no health information. */
    note: z.string().trim().min(1).max(WAITLIST_NOTE_MAX).optional(),
  })
  .strict()
  .openapi("ApplyWaitlist");
export type ApplyWaitlistInput = z.infer<typeof ApplyWaitlistSchema>;

export const WaitlistEntryResultSchema = z
  .object({
    id: z.uuid(),
    status: z.enum(WAITLIST_STATUSES),
    offerExpiresAt: z.iso.datetime().nullable(),
    /** The pending join request created with the application of a non-member. */
    joinRequestId: z.uuid().nullable(),
  })
  .openapi("WaitlistEntryResult");
export type WaitlistEntryResult = z.infer<typeof WaitlistEntryResultSchema>;

export const GroupWaitlistQuerySchema = z.object({
  /** Open entries (default) or those closed in the last 12 months. */
  status: z.enum(["open", "closed"]).default("open"),
  birthYear: z.coerce.number().int().min(1900).max(2200).optional(),
  /** Only applicants who fit the group's gender category (or `any`). */
  fitsGender: z.enum(["true"]).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type GroupWaitlistQuery = z.infer<typeof GroupWaitlistQuerySchema>;

export const GroupWaitlistEntrySchema = z.object({
  id: z.uuid(),
  person: PersonSummarySchema,
  status: z.enum(WAITLIST_STATUSES),
  /** Rank among the waiting (1 = next); null when not waiting. */
  position: z.number().int().nullable(),
  /** Who applied (a guardian); null when the applicant applied or is hidden. */
  requestedBy: PersonSummarySchema.nullable(),
  birthYear: z.number().int().nullable(),
  /** Fits the group's birth years; null when the group or the person has none. */
  fitsBirthYears: z.boolean().nullable(),
  /** Fits the group's gender category (computed, the gender is not shown); null if unknown. */
  fitsGenderCategory: z.boolean().nullable(),
  queuedAt: z.iso.datetime(),
  priority: z.number().int(),
  priorityReason: z.enum(WAITLIST_PRIORITY_REASONS).nullable(),
  applicantNote: z.string().nullable(),
  ownerNote: z.string().nullable(),
  offeredAt: z.iso.datetime().nullable(),
  offerExpiresAt: z.iso.datetime().nullable(),
  /** The offer went out by the worker (auto-offer). */
  autoOffer: z.boolean(),
  outOfOrderReason: z.string().nullable(),
  closedReason: z.enum(WAITLIST_CLOSED_REASONS).nullable(),
  decidedAt: z.iso.datetime().nullable(),
  /** Admitted to the group but waiting for the club to approve the join request. */
  awaitingClub: z.boolean(),
});

export const GroupWaitlistSchema = z
  .object({ items: z.array(GroupWaitlistEntrySchema), nextCursor: z.uuid().nullable() })
  .openapi("GroupWaitlist");
export type GroupWaitlist = z.infer<typeof GroupWaitlistSchema>;

export const WaitlistSummarySchema = z
  .object({
    admissionMode: z.enum(ADMISSION_MODES),
    autoOffer: z.boolean(),
    offerReplyDays: z.number().int(),
    /** Null: unlimited. */
    capacity: z.number().int().nullable(),
    /** Members, outstanding offers and accepted entries. */
    occupied: z.number().int(),
    free: z.number().int().nullable(),
    waiting: z.number().int(),
    offers: z.number().int(),
    /** Accepted, waiting for the club to approve the join request. */
    accepted: z.number().int(),
  })
  .openapi("WaitlistSummary");
export type WaitlistSummary = z.infer<typeof WaitlistSummarySchema>;

export const UpdateWaitlistEntrySchema = z
  .object({
    priority: z.number().int().min(0).max(100).optional(),
    priorityReason: z.enum(WAITLIST_PRIORITY_REASONS).nullable().optional(),
    ownerNote: z.string().trim().max(WAITLIST_NOTE_MAX).nullable().optional(),
  })
  .strict()
  .openapi("UpdateWaitlistEntry");
export type UpdateWaitlistEntryInput = z.infer<typeof UpdateWaitlistEntrySchema>;

const outOfOrderReason = z.string().trim().min(1).max(WAITLIST_NOTE_MAX);

export const OfferWaitlistEntrySchema = z
  .object({
    /** Days to reply (default: the group's offer_reply_days); expires at the end of that day. */
    replyDays: z.number().int().min(1).max(60).optional(),
    /** Required when someone waiting is ahead (`out_of_order_reason_required`). */
    outOfOrderReason: outOfOrderReason.optional(),
    /** Offer although the group is full (audited). */
    overCapacity: z.boolean().optional(),
  })
  .strict()
  .openapi("OfferWaitlistEntry");
export type OfferWaitlistEntryInput = z.infer<typeof OfferWaitlistEntrySchema>;

export const AdmitWaitlistEntrySchema = z
  .object({
    outOfOrderReason: outOfOrderReason.optional(),
    overCapacity: z.boolean().optional(),
  })
  .strict()
  .openapi("AdmitWaitlistEntry");
export type AdmitWaitlistEntryInput = z.infer<typeof AdmitWaitlistEntrySchema>;

export const RemoveWaitlistEntrySchema = z
  .object({ reason: z.enum(WAITLIST_REMOVAL_REASONS) })
  .strict()
  .openapi("RemoveWaitlistEntry");
export type RemoveWaitlistEntryInput = z.infer<typeof RemoveWaitlistEntrySchema>;

export const ClubWaitlistsQuerySchema = z.object({
  /** Decisions from this day on (default: 12 months back). */
  from: z.iso.date().optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ClubWaitlistsQuery = z.infer<typeof ClubWaitlistsQuerySchema>;

export const WAITLIST_DECISION_KINDS = ["offer", "admission", "queue_bypass"] as const;

export const ClubWaitlistsSchema = z
  .object({
    /** Groups with a waiting list or entries (on the first page only). */
    groups: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        capacity: z.number().int().nullable(),
        occupied: z.number().int(),
        free: z.number().int().nullable(),
        waiting: z.number().int(),
        offers: z.number().int(),
        accepted: z.number().int(),
      }),
    ),
    /** Out-of-order offers and admissions and queue bypasses, newest first. */
    decisions: z.array(
      z.object({
        id: z.uuid(),
        kind: z.enum(WAITLIST_DECISION_KINDS),
        group: z.object({ id: z.uuid(), name: z.string() }),
        person: PersonSummarySchema,
        decidedBy: PersonSummarySchema.nullable(),
        decidedAt: z.iso.datetime(),
        reason: z.string(),
      }),
    ),
    nextCursor: z.uuid().nullable(),
  })
  .openapi("ClubWaitlists");
export type ClubWaitlists = z.infer<typeof ClubWaitlistsSchema>;

export const OpenGroupsSchema = z
  .object({
    items: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        kind: z.enum(GROUP_KINDS),
        parentName: z.string().nullable(),
        sport: z.string().nullable(),
        birthYearFrom: z.number().int().nullable(),
        birthYearTo: z.number().int().nullable(),
        genderCategory: z.enum(GENDER_CATEGORIES).nullable(),
        level: z.string().nullable(),
        full: z.boolean(),
        waiting: z.number().int(),
      }),
    ),
  })
  .openapi("OpenGroups");
export type OpenGroups = z.infer<typeof OpenGroupsSchema>;
