// SPDX-License-Identifier: AGPL-3.0-only
// Expense claims and attestation (P2.5 part B, ADR 0048 decisions 9–10): a
// driver turns their drives into a mileage claim at the rate the board
// decided; the claim is routed to the activity's creator if they may attest,
// otherwise to the group's attesters, then the club's; never one's own.
// Approved claims export to CSV. The `finance` feature. People appear only
// as PersonSummary from the presenter (ADR 0022).

import { PersonSummarySchema } from "../auth/schemas.ts";
import { z } from "../zod.ts";

export const EXPENSE_CLAIM_KINDS = ["mileage"] as const;
export type ExpenseClaimKind = (typeof EXPENSE_CLAIM_KINDS)[number];

export const EXPENSE_CLAIM_STATUSES = [
  "submitted",
  "approved",
  "rejected",
  "exported",
  "paid",
] as const;
export type ExpenseClaimStatus = (typeof EXPENSE_CLAIM_STATUSES)[number];

/** A claim has at most this many drives. */
export const EXPENSE_CLAIM_MAX_LINES = 100;
/** The CSV export has at most this many claims (a narrower period otherwise). */
export const EXPENSE_EXPORT_MAX_ROWS = 5000;

export const CreateMileageClaimSchema = z
  .object({
    clubId: z.uuid(),
    /** The group the drives were for (each drive's activity is the group's). */
    groupId: z.uuid(),
    /** The caller's cars (carpool offers) of activities that have started. */
    offerIds: z.array(z.uuid()).min(1).max(EXPENSE_CLAIM_MAX_LINES),
  })
  .strict()
  .openapi("CreateMileageClaim");
export type CreateMileageClaimInput = z.infer<typeof CreateMileageClaimSchema>;

export const ExpenseClaimLineSchema = z
  .object({
    id: z.uuid(),
    /** The drive it is for (none: the car pool was deleted since). */
    offerId: z.uuid().nullable(),
    description: z.string(),
    /** Kilometres. */
    quantity: z.number(),
    /** Minor units per kilometre. */
    unitAmountMinor: z.number().int(),
    amountMinor: z.number().int(),
  })
  .openapi("ExpenseClaimLine");

export const ExpenseClaimSchema = z
  .object({
    id: z.uuid(),
    clubId: z.uuid(),
    clubName: z.string().optional(),
    kind: z.enum(EXPENSE_CLAIM_KINDS),
    /** None: hidden (protected identity) or no longer known. */
    claimant: PersonSummarySchema.nullable(),
    groupId: z.uuid(),
    groupName: z.string(),
    activityId: z.uuid().nullable(),
    amountMinor: z.number().int(),
    currency: z.string(),
    status: z.enum(EXPENSE_CLAIM_STATUSES),
    /** Whom it was routed to (the activity's creator), if anyone. */
    routedTo: PersonSummarySchema.nullable(),
    decidedBy: PersonSummarySchema.nullable(),
    decidedAt: z.iso.datetime().nullable(),
    /** The attester's reason (a rejection always has one). */
    reason: z.string().nullable(),
    createdAt: z.iso.datetime(),
    lines: z.array(ExpenseClaimLineSchema),
    /** The caller may decide it now. */
    canDecide: z.boolean(),
  })
  .openapi("ExpenseClaim");
export type ExpenseClaim = z.infer<typeof ExpenseClaimSchema>;

export const ExpenseClaimPageSchema = z
  .object({ items: z.array(ExpenseClaimSchema), nextCursor: z.uuid().nullable() })
  .openapi("ExpenseClaimPage");
export type ExpenseClaimPage = z.infer<typeof ExpenseClaimPageSchema>;

export const ExpenseClaimQuerySchema = z.object({
  /** Default: those waiting for a decision. */
  status: z.enum(EXPENSE_CLAIM_STATUSES).default("submitted"),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ExpenseClaimQuery = z.infer<typeof ExpenseClaimQuerySchema>;

export const MyExpenseClaimQuerySchema = z.object({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type MyExpenseClaimQuery = z.infer<typeof MyExpenseClaimQuerySchema>;

export const ExpenseClaimParamsSchema = z.object({ clubId: z.uuid(), claimId: z.uuid() });

export const DecideExpenseClaimSchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    /** Required to reject; told to the claimant. */
    reason: z.string().trim().min(1).max(500).nullish(),
  })
  .strict()
  .refine((v) => v.decision === "approve" || Boolean(v.reason), {
    message: "a rejection needs a reason",
    path: ["reason"],
  })
  .openapi("DecideExpenseClaim");
export type DecideExpenseClaimInput = z.infer<typeof DecideExpenseClaimSchema>;

export const ExpenseExportQuerySchema = z.object({
  /** Claims decided in [from, to] (dates in the club's time zone). */
  from: z.iso.date(),
  to: z.iso.date(),
});
export type ExpenseExportQuery = z.infer<typeof ExpenseExportQuerySchema>;

/** The drives the caller may still claim for, with the rate (P2.5). */
export const ClaimableDrivesSchema = z
  .object({
    clubId: z.uuid(),
    currency: z.string(),
    /** Minor units per km; none: reimbursement is off. */
    mileageRate: z.number().int().nullable(),
    drives: z.array(
      z.object({
        offerId: z.uuid(),
        activityId: z.uuid(),
        activityTitle: z.string(),
        startsAt: z.iso.datetime(),
        groupIds: z.array(z.uuid()),
        direction: z.enum(["out", "back"]),
        /** None: no distance yet (the driver or the place's). */
        distanceKm: z.number().nullable(),
      }),
    ),
  })
  .openapi("ClaimableDrives");
export type ClaimableDrives = z.infer<typeof ClaimableDrivesSchema>;
