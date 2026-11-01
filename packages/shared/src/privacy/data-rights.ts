// SPDX-License-Identifier: AGPL-3.0-only
// "Download my data", account deletion and ward erasure (P1.8b, ADR 0041):
// statuses, limits and the requests and responses of their endpoints.
// People only as PersonSummary (presenter); IDs only in job payloads.

import { PersonSummarySchema } from "../auth/schemas.ts";
import { CLUB_ROLES } from "../domain/core.ts";
import { z } from "../zod.ts";
import { AssignmentSchema, LEAVE_BLOCKERS } from "./schemas.ts";

export const DATA_EXPORT_STATUSES = ["queued", "ready", "failed", "expired"] as const;
export type DataExportStatus = (typeof DATA_EXPORT_STATUSES)[number];

/** A ready file is downloadable this long, then deleted (the row stays). */
export const DATA_EXPORT_DAYS = 7;
/** Requests per requester and day (rolling 24 hours). */
export const DATA_EXPORTS_PER_DAY = 3;
/** Exports still queued after this long fail (the worker never got to them). */
export const DATA_EXPORT_STALE_HOURS = 2;
/** The version of data.json's schema (docs/api/data-export.md). */
export const DATA_EXPORT_SCHEMA_VERSION = 1;
/** Object key prefix of the files (own expiry rule, longer than DATA_EXPORT_DAYS). */
export const DATA_EXPORT_PREFIX = "data-exports/";

export const ERASURE_KINDS = ["account_deletion", "ward_erasure"] as const;
export type ErasureKind = (typeof ERASURE_KINDS)[number];
export const ERASURE_STATUSES = ["scheduled", "cancelled", "running", "done", "failed"] as const;
export type ErasureStatus = (typeof ERASURE_STATUSES)[number];
/** The installation's grace period (ERASURE_GRACE_DAYS) lies within these. */
export const ERASURE_GRACE_DAYS = { default: 14, min: 0, max: 30 } as const;

export const CreateDataExportSchema = z
  .object({
    /** Self (default) or a ward the caller is a full guardian of. */
    personId: z.uuid().optional(),
  })
  .openapi("CreateDataExport");

export const DataExportSchema = z
  .object({
    id: z.uuid(),
    /** Whose data; null if the requester may no longer see them. */
    subject: PersonSummarySchema.nullable(),
    subjectPersonId: z.uuid(),
    status: z.enum(DATA_EXPORT_STATUSES),
    createdAt: z.iso.datetime(),
    /** When the file is deleted (ready exports). */
    expiresAt: z.iso.datetime().nullable(),
    sizeBytes: z.number().int().nullable(),
    errorCode: z.string().nullable(),
  })
  .openapi("DataExport");
export type DataExport = z.infer<typeof DataExportSchema>;

export const DataExportsPageSchema = z
  .object({ items: z.array(DataExportSchema), nextCursor: z.uuid().nullable() })
  .openapi("DataExportsPage");

export const DataExportParamsSchema = z.object({ exportId: z.uuid() });

export const DataExportDownloadSchema = z
  .object({ url: z.url(), expiresAt: z.iso.datetime() })
  .openapi("DataExportDownload");

/** What stops an erasure: per club and person (the caller or a ward), with what to do. */
export const ErasureBlockerSchema = z
  .object({
    personId: z.uuid(),
    clubId: z.uuid(),
    clubName: z.string(),
    code: z.enum(LEAVE_BLOCKERS),
    /** For roles_must_be_removed: the assignments to end first. */
    assignments: z.array(AssignmentSchema).optional(),
    /** For outstanding_invoices: how many, and whom to contact (a role, never a name). */
    count: z.number().int().optional(),
    contactRole: z.enum(CLUB_ROLES).optional(),
  })
  .openapi("ErasureBlocker");
export type ErasureBlocker = z.infer<typeof ErasureBlockerSchema>;

export const ErasureRequestSchema = z
  .object({
    id: z.uuid(),
    personId: z.uuid(),
    kind: z.enum(ERASURE_KINDS),
    status: z.enum(ERASURE_STATUSES),
    scheduledFor: z.iso.datetime(),
    includeWardIds: z.array(z.uuid()),
    /** Whether the caller requested it (others may only cancel). */
    requestedByYou: z.boolean(),
  })
  .openapi("ErasureRequest");
export type ErasureRequest = z.infer<typeof ErasureRequestSchema>;

export const AccountDeletionPreviewSchema = z
  .object({
    /** Days between the request and the erasure. */
    graceDays: z.number().int(),
    /** Deletion is possible when there are none (the caller's and chosen wards'). */
    blockers: z.array(ErasureBlockerSchema),
    /**
     * Wards without a login whose only full guardian with a login is the
     * caller: erased too unless the caller keeps them.
     */
    wards: z.array(
      z.object({
        person: PersonSummarySchema,
        blockers: z.array(ErasureBlockerSchema),
      }),
    ),
    pending: ErasureRequestSchema.nullable(),
  })
  .openapi("AccountDeletionPreview");
export type AccountDeletionPreview = z.infer<typeof AccountDeletionPreviewSchema>;

export const ScheduleAccountDeletionSchema = z
  .object({ eraseWardIds: z.array(z.uuid()).max(20).default([]) })
  .openapi("ScheduleAccountDeletion");

export const WardParamsSchema = z.object({ personId: z.uuid() });

export const WardErasurePreviewSchema = z
  .object({
    graceDays: z.number().int(),
    /** The ward has a login of their own (they delete their account themselves). */
    hasLogin: z.boolean(),
    blockers: z.array(ErasureBlockerSchema),
    pending: ErasureRequestSchema.nullable(),
  })
  .openapi("WardErasurePreview");
export type WardErasurePreview = z.infer<typeof WardErasurePreviewSchema>;

export const PendingDeletionSchema = z
  .object({ scheduledFor: z.iso.datetime() })
  .openapi("PendingDeletion");
