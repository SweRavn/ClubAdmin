// SPDX-License-Identifier: AGPL-3.0-only
// Billing of the service to clubs (P1.13, ADR 0045; BILLING_ENABLED only):
// plans with prices, the club's choice, billing details, invoices with VAT
// and credit notes, payments, and the operators' tools. Amounts are integer
// minor units with an ISO 4217 currency; VAT rates in basis points.

import { z } from "../zod.ts";
import { PostalAddressSchema } from "./schemas.ts";

export const BILLING_PERIODS = ["month", "year"] as const;
export type BillingPeriodKey = (typeof BILLING_PERIODS)[number];
export const PAYMENT_METHODS = ["invoice", "card"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const INVOICE_KINDS = ["invoice", "credit_note"] as const;
export const INVOICE_STATUSES = ["draft", "open", "paid", "void"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export const PAYMENT_STATUSES = ["pending", "succeeded", "failed"] as const;
export const INVOICE_LOCALES = ["sv", "en", "nb"] as const;
export const VAT_NOTES = ["none", "reverse_charge", "outside_scope"] as const;
export const CREDIT_REASONS = [
  "duplicate",
  "wrong_amount",
  "goodwill",
  "cancelled",
  "other",
] as const;
export type CreditReason = (typeof CREDIT_REASONS)[number];

const minor = z.number().int();
const planKey = z
  .string()
  .regex(/^[a-z0-9]+(_[a-z0-9]+)*$/)
  .max(64);
const currency = z.string().regex(/^[A-Z]{3}$/);

/** A price excluding and including VAT for the buyer. */
export const PriceSchema = z.object({ exclVatMinor: minor, inclVatMinor: minor }).openapi("Price");

export const PlanOfferSchema = z
  .object({
    key: z.string(),
    name: z.string(),
    kind: z.enum(["base", "add_on"]),
    /** Null when the plan has no price in this currency and period. */
    prices: z.object({ month: PriceSchema.nullable(), year: PriceSchema.nullable() }),
    features: z.record(z.string(), z.boolean()),
    limits: z.record(z.string(), z.number().int().nullable()),
  })
  .openapi("PlanOffer");
export type PlanOffer = z.infer<typeof PlanOfferSchema>;

export const ClubPlansSchema = z
  .object({
    currency: z.string(),
    vatRateBp: z.number().int(),
    vatNote: z.enum(VAT_NOTES),
    /** A paid plan can be chosen (decision 5: only clubs the seller can invoice). */
    paidPlansAvailable: z.boolean(),
    termsVersion: z.string(),
    termsUrl: z.url().nullable(),
    plans: z.array(PlanOfferSchema),
  })
  .openapi("ClubPlans");
export type ClubPlans = z.infer<typeof ClubPlansSchema>;

export const SelectPlanSchema = z
  .object({
    planKey,
    addOns: z.array(planKey).max(20).default([]),
    billingPeriod: z.enum(BILLING_PERIODS).default("month"),
    /** The terms of service and DPA (BILLING_TERMS_VERSION); required for a paid plan. */
    acceptTerms: z.boolean().default(false),
    /** During a trial: start the paid period now instead of when the trial ends. */
    startNow: z.boolean().default(false),
  })
  .strict()
  .openapi("SelectPlan");
export type SelectPlanInput = z.input<typeof SelectPlanSchema>;

export const ScheduledChangeSchema = z
  .object({
    planKey: z.string().nullable(),
    addOns: z.array(z.string()).nullable(),
    billingPeriod: z.enum(BILLING_PERIODS).nullable(),
    at: z.iso.datetime().nullable(),
  })
  .openapi("ScheduledChange");

/** The club's subscription with the P1.13 fields (all optional: ADR 0029). */
export const SubscriptionDetailsSchema = z
  .object({
    billingPeriod: z.enum(BILLING_PERIODS).optional(),
    currency: z.string().optional(),
    cancelAtPeriodEnd: z.boolean().optional(),
    scheduledChange: ScheduledChangeSchema.nullable().optional(),
    pastDueSince: z.iso.datetime().nullable().optional(),
    paymentMethod: z
      .object({
        method: z.enum(PAYMENT_METHODS),
        cardBrand: z.string().nullable(),
        cardLast4: z.string().nullable(),
      })
      .nullable()
      .optional(),
    balanceDueMinor: z.number().int().optional(),
    /** The plan chosen during a trial, applied when it ends. */
    selectedAt: z.iso.datetime().nullable().optional(),
  })
  .openapi("SubscriptionDetails");

export const BillingAccountInputSchema = z
  .object({
    legalName: z.string().trim().min(1).max(200),
    organizationNumber: z.string().trim().max(30).nullish(),
    vatNumber: z
      .string()
      .trim()
      .regex(/^[A-Z]{2}[0-9A-Z]{2,13}$/)
      .nullish(),
    address: PostalAddressSchema,
    /** An organisation address (e.g. kassor@…), not a person's. */
    invoiceEmail: z.email().max(254),
    /** "Er referens": a role, not a name. */
    reference: z.string().trim().max(60).nullish(),
    invoiceLocale: z.enum(INVOICE_LOCALES).default("sv"),
  })
  .strict()
  .openapi("BillingAccountInput");
export type BillingAccountInput = z.input<typeof BillingAccountInputSchema>;

export const BillingAccountSchema = z
  .object({
    legalName: z.string(),
    organizationNumber: z.string().nullable(),
    vatNumber: z.string().nullable(),
    address: PostalAddressSchema.nullable(),
    invoiceEmail: z.string().nullable(),
    reference: z.string().nullable(),
    invoiceLocale: z.enum(INVOICE_LOCALES),
    paymentMethod: z.enum(PAYMENT_METHODS),
    cardBrand: z.string().nullable(),
    cardLast4: z.string().nullable(),
    termsVersion: z.string().nullable(),
    termsAcceptedAt: z.iso.datetime().nullable(),
    complete: z.boolean(),
  })
  .openapi("BillingAccount");
export type BillingAccount = z.infer<typeof BillingAccountSchema>;

export const BillingAccountResponseSchema = z
  .object({ account: BillingAccountSchema.nullable() })
  .openapi("BillingAccountResponse");

export const PaymentMethodRequestSchema = z
  .object({ method: z.enum(PAYMENT_METHODS) })
  .strict()
  .openapi("PaymentMethodRequest");

export const PaymentMethodResultSchema = z
  .object({ method: z.enum(PAYMENT_METHODS), redirectUrl: z.url().nullable() })
  .openapi("PaymentMethodResult");

export const InvoiceSummarySchema = z
  .object({
    id: z.uuid(),
    number: z.string().nullable(),
    kind: z.enum(INVOICE_KINDS),
    status: z.enum(INVOICE_STATUSES),
    currency: z.string(),
    subtotalMinor: minor,
    vatMinor: minor,
    totalMinor: minor,
    balanceMinor: minor,
    periodStart: z.iso.datetime(),
    periodEnd: z.iso.datetime(),
    issuedAt: z.iso.datetime().nullable(),
    dueAt: z.iso.datetime().nullable(),
    paidAt: z.iso.datetime().nullable(),
    paymentMethod: z.enum(PAYMENT_METHODS).nullable(),
    hasPdf: z.boolean(),
    /** Operators: the club. */
    club: z.object({ id: z.uuid(), name: z.string(), country: z.string() }).optional(),
  })
  .openapi("InvoiceSummary");
export type InvoiceSummary = z.infer<typeof InvoiceSummarySchema>;

export const InvoicePageSchema = z
  .object({ items: z.array(InvoiceSummarySchema), nextCursor: z.uuid().nullable() })
  .openapi("InvoicePage");
export type InvoicePage = z.infer<typeof InvoicePageSchema>;

export const InvoiceLineSchema = z
  .object({
    descriptionKey: z.string(),
    planKey: z.string().nullable(),
    planName: z.string().nullable(),
    quantity: z.number().int(),
    unitMinor: minor,
    amountMinor: minor,
    periodStart: z.iso.datetime().nullable(),
    periodEnd: z.iso.datetime().nullable(),
    proration: z.boolean(),
    vatRateBp: z.number().int(),
    vatMinor: minor,
  })
  .openapi("InvoiceLine");

export const PaymentSummarySchema = z
  .object({
    id: z.uuid(),
    provider: z.string(),
    amountMinor: minor,
    currency: z.string(),
    status: z.enum(PAYMENT_STATUSES),
    receivedOn: z.iso.date().nullable(),
    recordedAt: z.iso.datetime(),
    invoiceId: z.uuid().optional(),
    invoiceNumber: z.string().nullable().optional(),
    club: z.object({ id: z.uuid(), name: z.string() }).optional(),
  })
  .openapi("PaymentSummary");

export const InvoiceDetailSchema = InvoiceSummarySchema.extend({
  lines: z.array(InvoiceLineSchema),
  vatSummary: z.array(z.object({ rateBp: z.number().int(), baseMinor: minor, vatMinor: minor })),
  vatNote: z.enum(VAT_NOTES),
  payments: z.array(PaymentSummarySchema),
  /** Bankgiro payment instructions for open invoices. */
  instructions: z
    .object({ bankgiro: z.string(), ocrReference: z.string(), amountMinor: minor })
    .nullable(),
  creditedInvoiceId: z.uuid().nullable(),
  creditReason: z.enum(CREDIT_REASONS).nullable(),
}).openapi("InvoiceDetail");
export type InvoiceDetail = z.infer<typeof InvoiceDetailSchema>;

export const InvoiceParamsSchema = z.object({ clubId: z.uuid(), invoiceId: z.uuid() });
export const InvoiceIdParamsSchema = z.object({ invoiceId: z.uuid() });
export const InvoiceListQuerySchema = z.object({ cursor: z.uuid().optional() });

export const DownloadUrlSchema = z
  .object({ url: z.url(), expiresAt: z.iso.datetime() })
  .openapi("DownloadUrl");

// --- Operators -----------------------------------------------------------------------------

export const PlanPriceInputSchema = z.object({
  currency,
  period: z.enum(BILLING_PERIODS),
  priceMinor: z.number().int().min(0).max(100_000_000),
});

export const PlanEntitlementsInputSchema = z.object({
  features: z.record(z.string(), z.boolean()).default({}),
  limits: z.record(z.string(), z.number().int().min(0).nullable()).default({}),
});

export const CreatePlanSchema = z
  .object({
    key: planKey,
    name: z.string().trim().min(1).max(100),
    kind: z.enum(["base", "add_on"]),
    prices: z.array(PlanPriceInputSchema).min(1).max(10),
  })
  .extend(PlanEntitlementsInputSchema.shape)
  .strict()
  .openapi("CreatePlan");
export type CreatePlanInput = z.input<typeof CreatePlanSchema>;

export const UpdatePlanSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    active: z.boolean().optional(),
    features: z.record(z.string(), z.boolean()).optional(),
    limits: z.record(z.string(), z.number().int().min(0).nullable()).optional(),
    /** New prices; an existing price of the same currency and period is deactivated. */
    addPrices: z.array(PlanPriceInputSchema).max(10).optional(),
    /** Deactivate prices (currency and period). */
    removePrices: z
      .array(z.object({ currency, period: z.enum(BILLING_PERIODS) }))
      .max(10)
      .optional(),
  })
  .strict()
  .openapi("UpdatePlan");
export type UpdatePlanInput = z.infer<typeof UpdatePlanSchema>;

export const PlanParamsSchema = z.object({ planId: z.uuid() });

export const OperatorSubscriptionsQuerySchema = z.object({
  status: z.string().max(20).optional(),
  plan: planKey.optional(),
  cursor: z.uuid().optional(),
});

export const OperatorSubscriptionSchema = z
  .object({
    club: z.object({ id: z.uuid(), name: z.string(), country: z.string() }),
    subscriptionId: z.uuid(),
    planKey: z.string(),
    addOns: z.array(z.string()),
    status: z.string(),
    billingPeriod: z.enum(BILLING_PERIODS),
    trialEndsAt: z.iso.datetime().nullable(),
    currentPeriodEnd: z.iso.datetime().nullable(),
    pastDueSince: z.iso.datetime().nullable(),
    paymentMethod: z.enum(PAYMENT_METHODS).nullable(),
    balanceDueMinor: minor,
    accessState: z.string(),
  })
  .openapi("OperatorSubscription");

export const OperatorSubscriptionPageSchema = z
  .object({ items: z.array(OperatorSubscriptionSchema), nextCursor: z.uuid().nullable() })
  .openapi("OperatorSubscriptionPage");

export const TrialChangeSchema = z
  .object({ trialEndsAt: z.iso.datetime() })
  .strict()
  .openapi("TrialChange");

export const OperatorInvoicesQuerySchema = z.object({
  status: z.enum(INVOICE_STATUSES).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  cursor: z.uuid().optional(),
});

export const OperatorPaymentsQuerySchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  cursor: z.uuid().optional(),
});

export const PaymentPageSchema = z
  .object({ items: z.array(PaymentSummarySchema), nextCursor: z.uuid().nullable() })
  .openapi("PaymentPage");

export const RecordPaymentSchema = z
  .object({
    amountMinor: z.number().int().min(1),
    receivedOn: z.iso.date(),
    /** The bank's reference of the payment; recording the same one twice changes nothing. */
    reference: z.string().trim().min(1).max(100),
  })
  .strict()
  .openapi("RecordPayment");
export type RecordPaymentInput = z.infer<typeof RecordPaymentSchema>;

export const CreditNoteSchema = z
  .object({
    reason: z.enum(CREDIT_REASONS),
    /** Line indexes of the invoice to credit; all lines when absent. */
    lines: z.array(z.number().int().min(0)).max(50).optional(),
  })
  .strict()
  .openapi("CreditNote");
export type CreditNoteInput = z.infer<typeof CreditNoteSchema>;
