// SPDX-License-Identifier: AGPL-3.0-only
// Grant reports (P2.7 part B, ADR 0051): the schemes of a club's enabled
// grant plugins with their periods and deadlines, a period's report (what
// counts and why, the totals, the missing data), locking it and exporting
// its files. Reason codes come with the plugin's texts in the caller's
// language; people only through the PersonPresenter.

import { PersonSummarySchema } from "../auth/schemas.ts";
import { z } from "../zod.ts";

const day = z.iso.date();
const pluginId = z.string().regex(/^[a-z]{2,}(\.[a-z0-9-]+)+$/);

export const GRANT_REPORT_STATUSES = [
  "draft",
  "locked",
  "exported",
  "submitted",
  "accepted",
  "rejected",
] as const;
export type GrantReportStatus = (typeof GRANT_REPORT_STATUSES)[number];

export const GrantPeriodSchema = z
  .object({
    key: z.string(),
    from: day,
    to: day,
    referenceDate: day.nullable(),
    deadline: day,
    late: z.array(z.object({ until: day, percent: z.number() })),
    refusedAfter: day.nullable(),
  })
  .openapi("GrantPeriod");
export type GrantPeriod = z.infer<typeof GrantPeriodSchema>;

export const GrantSchemeListSchema = z
  .object({
    items: z.array(
      z.object({
        pluginId,
        key: z.string(),
        /** The plugin's name for it, in the caller's language. */
        name: z.string(),
        basis: z.enum(["session", "membership_snapshot", "leader"]),
        formats: z.array(z.string()),
        integration: z.boolean(),
        /** Last year's and this year's periods. */
        periods: z.array(GrantPeriodSchema),
      }),
    ),
    /** Enabled plugins that did not answer. */
    unavailable: z.array(pluginId),
  })
  .openapi("GrantSchemeList");
export type GrantSchemeList = z.infer<typeof GrantSchemeListSchema>;

export const GrantReportQuerySchema = z.object({
  pluginId,
  scheme: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
  period: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
});
export type GrantReportQuery = z.infer<typeof GrantReportQuerySchema>;

export const GrantReportSchema = z
  .object({
    id: z.uuid(),
    pluginId,
    scheme: z.string(),
    period: GrantPeriodSchema,
    status: z.enum(GRANT_REPORT_STATUSES),
    evaluatedAt: z.iso.datetime().nullable(),
    lockedAt: z.iso.datetime().nullable(),
    lockedBy: PersonSummarySchema.nullable(),
    /** Attendance changed in the period after it was locked. */
    attendanceChangedAt: z.iso.datetime().nullable(),
    /** Session reports: each held session, whether it counts and why. */
    sessions: z.array(
      z.object({
        sessionId: z.uuid(),
        title: z.string(),
        date: day,
        counts: z.boolean(),
        codes: z.array(z.string()),
        counted: z.number().int(),
      }),
    ),
    /** The people in the report (hidden ones left out), what counted and why. */
    people: z.array(
      z.object({
        person: PersonSummarySchema,
        counted: z.number().int(),
        codes: z.array(z.string()),
      }),
    ),
    totals: z.array(
      z.object({
        measure: z.string(),
        dimensions: z.record(z.string(), z.string()),
        value: z.number(),
      }),
    ),
    /** Data to fix before locking: the person and the field. */
    missing: z.array(z.object({ person: PersonSummarySchema, field: z.string() })),
    /** The plugin's texts for every code and measure, in the caller's language. */
    texts: z.record(z.string(), z.string()),
  })
  .openapi("GrantReport");
export type GrantReport = z.infer<typeof GrantReportSchema>;

export const GrantReportParamsSchema = z.object({ clubId: z.uuid(), reportId: z.uuid() });

export const GrantExportSchema = z
  .object({ format: z.enum(["csv", "pdf", "xml", "json"]) })
  .strict()
  .openapi("GrantExportRequest");
export type GrantExportInput = z.infer<typeof GrantExportSchema>;

export const GrantFilesSchema = z
  .object({
    files: z.array(
      z.object({
        name: z.string(),
        mediaType: z.string(),
        /** Base64. */
        content: z.string(),
      }),
    ),
  })
  .openapi("GrantFiles");
export type GrantFiles = z.infer<typeof GrantFilesSchema>;
