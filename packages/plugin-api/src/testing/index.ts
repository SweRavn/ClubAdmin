// SPDX-License-Identifier: AGPL-3.0-only
// The conformance suite every plugin runs (P2.7 tests, item 1): the manifest
// is valid and its texts complete in sv, en and nb for every label and every
// reason code the plugin returns; outputs are valid; the same input gives the
// same output; the plugin reads only the data it declares and calls only the
// hosts it declares; every call finishes in time. A plugin's own test calls
// `checkConformance(plugin, samples)` and expects no problems.

import { z } from "@clubadmin/shared";

import {
  type CheckResult,
  CheckTypeSchema,
  FeedEntrySchema,
  type PresentedInput,
  PresentedOutcomeSchema,
  RequestStateSchema,
  RequirementSchema,
  type StartRequestInput,
} from "../checks.ts";
import {
  memoryState,
  type PluginClub,
  type PluginContext,
  type PluginHttpRequest,
  type PluginHttpResponse,
  restrictedHttp,
  safeLogger,
} from "../context.ts";
import {
  allowedPersonFields,
  minimizePerson,
  minimizeSession,
  type PluginPerson,
  type PluginSession,
} from "../data.ts";
import {
  EXPORT_FORMATS,
  ExportFileSchema,
  type GrantReport,
  type Period,
  PeriodEvaluationSchema,
  PeriodSchema,
  SchemeSchema,
  SessionEvaluationSchema,
  SnapshotSchema,
} from "../grants.ts";
import { callPlugin, pluginProblems } from "../host.ts";
import type { Plugin } from "../plugin.ts";

export interface ConformanceSamples {
  club?: PluginClub;
  config?: Record<string, string | number | boolean>;
  secrets?: Record<string, string>;
  now?: Date;
  /** The remote services the plugin calls (only declared hosts reach it). */
  http?: (url: string, init: PluginHttpRequest) => Promise<PluginHttpResponse>;
  grants?: { year: number; sessions: PluginSession[]; people: PluginPerson[] };
  checks?: {
    presented?: PresentedInput[];
    requests?: StartRequestInput[];
    feed?: { since: string; people: { id: string; personalIdentityNumber?: string | null }[] };
  };
  /** A call slower than this is a problem (default 2 s). */
  timeoutMs?: number;
}

const DEFAULT_CLUB: PluginClub = {
  id: "0199a000-0000-7000-8001-0000000000ff",
  country: "SE",
  timeZone: "Europe/Stockholm",
  locale: "sv-SE",
};

/** Text keys found in a value: every `codes` entry, `reason`, `name`, `measure`, `basis`, `cost`. */
function textKeysIn(value: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(value)) for (const v of value) textKeysIn(v, into);
  else if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      if (key === "codes" && Array.isArray(v)) for (const c of v) into.add(String(c));
      else if (key === "name" && "mediaType" in value)
        continue; // a file name, not a text
      else if (["reason", "name", "measure", "cost"].includes(key) && typeof v === "string") {
        into.add(v);
      } else if (key === "basis" && typeof v === "string" && "category" in value) {
        into.add(v);
      } else textKeysIn(v, into);
    }
  }
  return into;
}

/** Wraps people so that reading an undeclared field is recorded. */
function watched(people: PluginPerson[], allowed: Set<string>, reads: Set<string>): PluginPerson[] {
  const ignore = new Set(["toJSON", "then", "constructor", "$$typeof"]);
  return people.map(
    (p) =>
      new Proxy(p, {
        get(target, prop, receiver) {
          if (typeof prop === "string" && !allowed.has(prop) && !ignore.has(prop)) reads.add(prop);
          return Reflect.get(target, prop, receiver) as unknown;
        },
        has(target, prop) {
          if (typeof prop === "string" && !allowed.has(prop)) reads.add(prop);
          return Reflect.has(target, prop);
        },
      }),
  );
}

export async function checkConformance(
  plugin: Plugin,
  samples: ConformanceSamples = {},
): Promise<string[]> {
  const problems = pluginProblems(plugin);
  if (problems.length) return problems;
  const manifest = plugin.manifest;
  const timeoutMs = samples.timeoutMs ?? 2_000;
  const refused = new Set<string>();
  const redacted = new Set<string>();
  const ctx: PluginContext = {
    club: samples.club ?? DEFAULT_CLUB,
    config: samples.config ?? {},
    secrets: samples.secrets ?? {},
    now: () => samples.now ?? new Date("2026-11-18T12:00:00Z"),
    log: safeLogger(
      () => undefined,
      (_event, field) => redacted.add(field),
    ),
    http: restrictedHttp(
      manifest.network,
      samples.http ??
        (() =>
          Promise.resolve({ status: 503, headers: {}, body: "" } satisfies PluginHttpResponse)),
      (host) => refused.add(host),
    ),
    state: memoryState(),
  };
  const texts = new Set(Object.keys(manifest.texts.sv));
  const used = new Set<string>();
  const reads = new Set<string>();
  const allowed = new Set<string>(allowedPersonFields(manifest.data));

  /** Calls twice (determinism), validates, collects text keys; null on failure. */
  const call = async <T>(
    label: string,
    run: () => Promise<unknown>,
    schema: z.ZodType<T>,
    deterministic = true,
  ) => {
    const first = await callPlugin(run, schema, timeoutMs);
    if (!first.ok) {
      problems.push(`${label}: ${first.error} (${first.detail})`);
      return null;
    }
    const second = deterministic ? await callPlugin(run, schema, timeoutMs) : first;
    if (second.ok && JSON.stringify(second.value) !== JSON.stringify(first.value)) {
      problems.push(`${label}: not deterministic`);
    }
    textKeysIn(first.value, used);
    return first.value;
  };

  const grants = plugin.grantReporting;
  if (grants) {
    const schemes = await call("schemes", () => grants.schemes(ctx), z.array(SchemeSchema));
    const sample = samples.grants;
    for (const scheme of schemes ?? []) {
      if (!sample) {
        problems.push("grant-reporting: no sample data given");
        break;
      }
      const periods = await call(
        `${scheme.key}.periods`,
        () => grants.periods(ctx, scheme.key, sample.year),
        z.array(PeriodSchema),
      );
      const period: Period | undefined = periods?.[0];
      if (!period) {
        problems.push(`${scheme.key}: no period in ${sample.year}`);
        continue;
      }
      const people = () =>
        watched(
          sample.people.map((p) => minimizePerson(p, manifest.data)),
          allowed,
          reads,
        );
      const sessions = sample.sessions
        .filter((s) => s.date >= period.from && s.date <= period.to)
        .map((s) => minimizeSession(s, manifest.data));
      let report: GrantReport | null = null;
      if (scheme.basis === "membership_snapshot") {
        if (!grants.snapshot) problems.push(`${scheme.key}: a snapshot scheme needs snapshot()`);
        else {
          const snapshot = await call(
            `${scheme.key}.snapshot`,
            () => grants.snapshot!(ctx, scheme.key, period, people()),
            SnapshotSchema,
          );
          if (snapshot) {
            report = {
              id: "r",
              scheme: scheme.key,
              period,
              evaluation: null,
              snapshot,
              people: people(),
              sessions: [],
            };
          }
        }
      } else {
        if (!grants.evaluatePeriod) problems.push(`${scheme.key}: needs evaluatePeriod()`);
        else {
          const evaluation = await call(
            `${scheme.key}.evaluatePeriod`,
            () => grants.evaluatePeriod!(ctx, scheme.key, period, sessions, people()),
            PeriodEvaluationSchema,
          );
          if (evaluation) {
            report = {
              id: "r",
              scheme: scheme.key,
              period,
              evaluation,
              snapshot: null,
              people: people(),
              sessions,
            };
          }
        }
        if (scheme.basis === "session" && grants.evaluateSession) {
          for (const session of sessions.slice(0, 5)) {
            await call(
              `${scheme.key}.evaluateSession`,
              () => grants.evaluateSession!(ctx, scheme.key, session, people()),
              SessionEvaluationSchema,
            );
          }
        }
      }
      if (report) {
        for (const format of scheme.formats) {
          if (!(EXPORT_FORMATS as readonly string[]).includes(format)) continue;
          const files = await call(
            `${scheme.key}.export.${format}`,
            () => grants.export(ctx, scheme.key, report, format),
            z.array(ExportFileSchema).min(1),
          );
          for (const file of files ?? []) {
            if (!/^[A-Za-z0-9+/]*={0,2}$/.test(file.content))
              problems.push(`${file.name}: not base64`);
          }
        }
      }
      if (scheme.integration && (!grants.submit || !grants.submissionStatus)) {
        problems.push(
          `${scheme.key}: integration declared without submit() and submissionStatus()`,
        );
      }
    }
  }

  const checks = plugin.backgroundChecks;
  if (checks) {
    const types = await call(
      "checkTypes",
      () => checks.checkTypes(ctx),
      z.array(CheckTypeSchema).min(1),
    );
    const requirements = await call(
      "requirements",
      () => checks.requirements(ctx),
      z.array(RequirementSchema),
    );
    const keys = new Set((types ?? []).map((t) => t.key));
    for (const r of requirements ?? []) {
      if (!keys.has(r.checkType))
        problems.push(`requirement for unknown check type ${r.checkType}`);
    }
    for (const type of types ?? []) {
      const needs =
        type.initiator === "person"
          ? checks.verifyPresented
          : type.initiator === "club"
            ? checks.startRequest && checks.requestStatus
            : checks.feed;
      if (!needs)
        problems.push(`check type ${type.key}: the ${type.initiator} flow is not implemented`);
    }
    const resultOk = (label: string, result: CheckResult | null | undefined) => {
      if (result && !keys.has(result.checkType)) problems.push(`${label}: unknown check type`);
    };
    for (const [i, input] of (samples.checks?.presented ?? []).entries()) {
      const outcome = await call(
        `verifyPresented[${i}]`,
        () => checks.verifyPresented!(ctx, input),
        PresentedOutcomeSchema,
      );
      if (outcome?.outcome === "verified") resultOk(`verifyPresented[${i}]`, outcome.result);
    }
    for (const [i, input] of (samples.checks?.requests ?? []).entries()) {
      // Requests change state (consent given, submitted, …): not called twice.
      const started = await call(
        `startRequest[${i}]`,
        () => checks.startRequest!(ctx, input),
        RequestStateSchema,
        false,
      );
      if (started) {
        const state = await call(
          `requestStatus[${i}]`,
          () => checks.requestStatus!(ctx, started.reference),
          RequestStateSchema,
          false,
        );
        resultOk(`requestStatus[${i}]`, state?.result);
      }
    }
    const feed = samples.checks?.feed;
    if (feed && checks.feed) {
      const entries = await call(
        "feed",
        () => checks.feed!(ctx, feed.since, feed.people),
        z.array(FeedEntrySchema),
      );
      for (const e of entries ?? []) resultOk("feed", e.result);
    }
  }

  for (const key of used) if (!texts.has(key)) problems.push(`text ${key} is missing`);
  for (const field of reads) problems.push(`reads undeclared data: ${field}`);
  for (const host of refused) problems.push(`calls an undeclared host: ${host}`);
  for (const field of redacted) problems.push(`logs personal data or free text in ${field}`);
  return problems;
}

export { DEFAULT_CLUB };

/** A context for a plugin's own scenario tests (memory state, fixed clock, fake remote). */
export function testContext(
  over: Partial<Omit<ConformanceSamples, "grants" | "checks">> & {
    network?: readonly string[];
  } = {},
): PluginContext {
  return {
    club: over.club ?? DEFAULT_CLUB,
    config: over.config ?? {},
    secrets: over.secrets ?? {},
    now: () => over.now ?? new Date("2026-11-18T12:00:00Z"),
    log: safeLogger(() => undefined),
    http: restrictedHttp(
      over.network ?? [],
      over.http ?? (() => Promise.resolve({ status: 503, headers: {}, body: "" })),
    ),
    state: memoryState(),
  };
}
