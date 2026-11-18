// SPDX-License-Identifier: AGPL-3.0-only
// The grant-reporting capability (ADR 0051 decision 5). A plugin declares
// schemes (per session, per member on a reference date, per leader) with
// their periods and deadlines; it evaluates a single session (the live hint
// in the attendance view), a whole period (rules across sessions) or a
// membership snapshot, and turns a locked report into files or a
// submission. Results name sessions and people by ID with reason codes; the
// codes are texts of the manifest.

import { z } from "@clubadmin/shared";

import type { PluginContext } from "./context.ts";
import { type PluginPerson, type PluginSession } from "./data.ts";
import { DATA_FIELDS } from "./manifest.ts";

const day = z.iso.date();
const code = z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/);
const key = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);

export const GRANT_BASES = ["session", "membership_snapshot", "leader"] as const;
export const EXPORT_FORMATS = ["csv", "pdf", "xml", "json"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const SchemeSchema = z
  .object({
    key,
    /** A text key of the manifest. */
    name: code,
    basis: z.enum(GRANT_BASES),
    /** Data the scheme needs from every counted person (listed as missing otherwise). */
    required: z.array(z.enum(DATA_FIELDS)),
    formats: z.array(z.enum(EXPORT_FORMATS)).min(1),
    /** The scheme can be submitted through an integration (`submit`). */
    integration: z.boolean(),
  })
  .strict();
export type Scheme = z.infer<typeof SchemeSchema>;

export const PeriodSchema = z
  .object({
    /** E.g. `2026-1` or `2026`. */
    key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
    from: day,
    to: day,
    /** For a snapshot: the reference date. */
    referenceDate: day.nullable(),
    /** The last day to report in full. */
    deadline: day,
    /** Reductions after the deadline, in order (a report on or before `until` loses `percent`). */
    late: z.array(z.object({ until: day, percent: z.number().min(0).max(100) })),
    /** Reports after this day are refused (null: never). */
    refusedAfter: day.nullable(),
  })
  .strict()
  .refine((p) => p.to >= p.from, { message: "period ends before it starts" });
export type Period = z.infer<typeof PeriodSchema>;

export const SessionEvaluationSchema = z
  .object({
    sessionId: z.uuid(),
    counts: z.boolean(),
    /** Why it does not count, or notes on what counted (text keys). */
    codes: z.array(code),
    /** The people it counts for (participants and leaders counted as such). */
    countedPersonIds: z.array(z.uuid()),
  })
  .strict();
export type SessionEvaluation = z.infer<typeof SessionEvaluationSchema>;

export const MissingDataSchema = z
  .object({ personId: z.uuid(), field: z.enum(DATA_FIELDS) })
  .strict();
export type MissingData = z.infer<typeof MissingDataSchema>;

/** Totals as rows of dimensions (e.g. age band, sex, sport) and a count. */
export const TotalSchema = z
  .object({
    /** A text key of the manifest naming what is counted. */
    measure: code,
    dimensions: z.record(key, z.string().max(60)),
    value: z.number(),
  })
  .strict();
export type Total = z.infer<typeof TotalSchema>;

export const PeriodEvaluationSchema = z
  .object({
    sessions: z.array(SessionEvaluationSchema),
    people: z.array(
      z
        .object({ personId: z.uuid(), counted: z.number().int().min(0), codes: z.array(code) })
        .strict(),
    ),
    totals: z.array(TotalSchema),
    missing: z.array(MissingDataSchema),
  })
  .strict();
export type PeriodEvaluation = z.infer<typeof PeriodEvaluationSchema>;

export const SnapshotSchema = z
  .object({
    referenceDate: day,
    /** The people counted, by ID, with the codes of the categories they fell in. */
    people: z.array(z.object({ personId: z.uuid(), codes: z.array(code) }).strict()),
    totals: z.array(TotalSchema),
    missing: z.array(MissingDataSchema),
  })
  .strict();
export type Snapshot = z.infer<typeof SnapshotSchema>;

/** A locked report the host hands back for export or submission. */
export interface GrantReport {
  id: string;
  scheme: string;
  period: Period;
  evaluation: PeriodEvaluation | null;
  snapshot: Snapshot | null;
  /** The people in the report with the declared data (for files that list them). */
  people: PluginPerson[];
  sessions: PluginSession[];
}

export const ExportFileSchema = z
  .object({
    name: z.string().regex(/^[\w.-]{1,100}$/),
    mediaType: z.string().regex(/^[a-z]+\/[\w.+-]+$/),
    /** Base64. */
    content: z.string(),
  })
  .strict();
export type ExportFile = z.infer<typeof ExportFileSchema>;

export const SUBMISSION_STATUSES = ["submitted", "accepted", "rejected"] as const;
export const SubmissionSchema = z
  .object({
    /** The integration's receipt (not personal data). */
    receipt: z.string().min(1).max(200),
    status: z.enum(SUBMISSION_STATUSES),
    /** A text key of the manifest explaining a rejection. */
    reason: code.nullable(),
  })
  .strict();
export type Submission = z.infer<typeof SubmissionSchema>;

export interface GrantReporting {
  schemes: (ctx: PluginContext) => Promise<Scheme[]>;
  periods: (ctx: PluginContext, scheme: string, year: number) => Promise<Period[]>;
  /** A single session (the attendance view's hint); `session` basis only. */
  evaluateSession?: (
    ctx: PluginContext,
    scheme: string,
    session: PluginSession,
    people: PluginPerson[],
  ) => Promise<SessionEvaluation>;
  /** A whole period (`session` and `leader` bases). */
  evaluatePeriod?: (
    ctx: PluginContext,
    scheme: string,
    period: Period,
    sessions: PluginSession[],
    people: PluginPerson[],
  ) => Promise<PeriodEvaluation>;
  /** Members counted on a reference date (`membership_snapshot` basis). */
  snapshot?: (
    ctx: PluginContext,
    scheme: string,
    period: Period,
    people: PluginPerson[],
  ) => Promise<Snapshot>;
  export: (
    ctx: PluginContext,
    scheme: string,
    report: GrantReport,
    format: ExportFormat,
  ) => Promise<ExportFile[]>;
  submit?: (ctx: PluginContext, scheme: string, report: GrantReport) => Promise<Submission>;
  submissionStatus?: (ctx: PluginContext, scheme: string, receipt: string) => Promise<Submission>;
}
