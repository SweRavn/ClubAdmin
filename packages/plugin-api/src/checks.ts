// SPDX-License-Identifier: AGPL-3.0-only
// The background-check capability (ADR 0051 decision 6 and its amendment).
// A plugin declares check types and requirements per duty category, and runs
// the flows: the person presents a certificate (a code checked with the
// authority during the call, never returned or stored), the club requests
// one with the person's consent, or a federation feed reports it. Results
// carry only the metadata the host may keep: never a document, a picture, a
// reference code or a negative outcome (a negative outcome is `closed`
// without a reason, GDPR Art. 10).

import { z } from "@clubadmin/shared";

import type { PluginContext } from "./context.ts";

const day = z.iso.date();
const key = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);
const code = z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/);

export const CHECK_INITIATORS = ["person", "club", "federation"] as const;
export const VERIFICATION_METHODS = [
  "viewed",
  "code_lookup",
  "digital_mailbox",
  "received_by_club",
  "federation_feed",
] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

/** The duty categories requirements are stated for (P2.6's contact with children maps to them). */
export const CHECK_CATEGORIES = [
  "regular_contact_with_children",
  "alone_with_children",
  "overnight",
  "board",
] as const;
export type CheckCategory = (typeof CHECK_CATEGORIES)[number];

export const CheckTypeSchema = z
  .object({
    key,
    /** A text key of the manifest. */
    name: code,
    initiator: z.enum(CHECK_INITIATORS),
    /** The certificate may be at most this old when presented (null: no limit). */
    maxAgeDaysWhenPresented: z.number().int().min(1).nullable(),
    /** A new check is needed after this many months (null: never). */
    recheckMonths: z.number().int().min(1).nullable(),
    /** From which age the check applies (null: any). */
    minAge: z.number().int().min(0).nullable(),
    /** Whether a copy may be kept; the host keeps none in any case. */
    copyRetention: z.enum(["none", "until_verified"]),
    methods: z.array(z.enum(VERIFICATION_METHODS)).min(1),
    /** A text key describing the cost (null: free). */
    cost: code.nullable(),
    integration: z.enum(["none", "available", "stubbed"]),
  })
  .strict();
export type CheckType = z.infer<typeof CheckTypeSchema>;

export const RequirementSchema = z
  .object({
    category: z.enum(CHECK_CATEGORIES),
    checkType: key,
    level: z.enum(["required", "recommended"]),
    /** A text key naming the law or rule. */
    basis: code,
  })
  .strict();
export type Requirement = z.infer<typeof RequirementSchema>;

/** What the host may keep about a check (ADR 0051): nothing else. */
export const CheckResultSchema = z
  .object({
    checkType: key,
    /** ISO 3166-1 alpha-2. */
    issuingCountry: z.string().regex(/^[A-Z]{2}$/),
    issuedOn: day,
    method: z.enum(VERIFICATION_METHODS),
    /** When a new check is needed (null: never). */
    validUntil: day.nullable(),
  })
  .strict();
export type CheckResult = z.infer<typeof CheckResultSchema>;

/** The person presents: the host passes what they show; nothing of it is kept. */
export interface PresentedInput {
  personId: string;
  checkType: string;
  issuedOn: string;
  /** How the club saw it (P2.8): on paper (`viewed`) or in the person's digital mailbox. */
  method?: VerificationMethod | null;
  /** A verification code from the certificate, used during this call only. */
  code?: string | null;
  personalIdentityNumber?: string | null;
  birthDate?: string | null;
}

export const PresentedOutcomeSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("verified"), result: CheckResultSchema }).strict(),
  /** Could not be verified (too old, code not accepted): the reason is a text key. */
  z.object({ outcome: z.literal("not_verified"), reason: code }).strict(),
  /** The certificate shows something: the case closes, no reason is returned. */
  z.object({ outcome: z.literal("closed") }).strict(),
]);
export type PresentedOutcome = z.infer<typeof PresentedOutcomeSchema>;

export const REQUEST_STATUSES = [
  "requested",
  "consent_pending",
  "submitted",
  "result_available",
  "verified",
  "closed",
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export interface StartRequestInput {
  personId: string;
  checkType: string;
  birthDate?: string | null;
  personalIdentityNumber?: string | null;
}

export const RequestStateSchema = z
  .object({
    /** The plugin's reference (kept by the host to ask again; not the certificate's code). */
    reference: z.string().min(1).max(200),
    status: z.enum(REQUEST_STATUSES),
    /** Only with status `verified`. */
    result: CheckResultSchema.nullable(),
  })
  .strict()
  .refine((s) => (s.status === "verified") === (s.result !== null), {
    message: "a result belongs to a verified request only",
  });
export type RequestState = z.infer<typeof RequestStateSchema>;

/** A federation's feed: the people it reports as checked (IDs the host matched). */
export const FeedEntrySchema = z.object({ personId: z.uuid(), result: CheckResultSchema }).strict();
export type FeedEntry = z.infer<typeof FeedEntrySchema>;

export interface BackgroundChecks {
  /**
   * Declarations (P2.8): the same for every club of the plugin's regions, no
   * network and no state. The host reads them once per process and enforces
   * them inside its transactions (chat, duties) without calling the plugin.
   */
  checkTypes: (ctx: PluginContext) => Promise<CheckType[]>;
  requirements: (ctx: PluginContext) => Promise<Requirement[]>;
  /** The person presents a certificate (initiator `person`). */
  verifyPresented?: (ctx: PluginContext, input: PresentedInput) => Promise<PresentedOutcome>;
  /** The club requests a check with the person's consent (initiator `club`). */
  startRequest?: (ctx: PluginContext, input: StartRequestInput) => Promise<RequestState>;
  requestStatus?: (ctx: PluginContext, reference: string) => Promise<RequestState>;
  /** A federation's feed since a date (initiator `federation`). */
  feed?: (
    ctx: PluginContext,
    since: string,
    people: { id: string; personalIdentityNumber?: string | null }[],
  ) => Promise<FeedEntry[]>;
}
