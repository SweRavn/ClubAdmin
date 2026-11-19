// SPDX-License-Identifier: AGPL-3.0-only
// Grant reports through the club's enabled plugins (P2.7 part B, ADR 0051):
// the schemes and their periods, a period's report (the host gathers the
// sessions, attendance and the people's declared data in one transaction,
// the plugin evaluates outside it), locking, exporting and the attendance
// view's hints. The host stores the evaluation (IDs and codes only) and
// never gives a plugin more than its manifest declares.

import { audit, type Database, outbox, type TenantContext, type Tx } from "@clubadmin/db";
import {
  ExportFileSchema,
  type GrantReport as PluginReport,
  minimizePerson,
  minimizeSession,
  type Period,
  type PeriodEvaluation,
  PeriodEvaluationSchema,
  PeriodSchema,
  type Plugin,
  type PluginPerson,
  type PluginSession,
  SchemeSchema,
  SessionEvaluationSchema,
  type Snapshot,
  SnapshotSchema,
} from "@clubadmin/plugin-api";
import { type GrantHint, type GrantSchemeList, localDate, z } from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import type { ClubsService } from "../clubs/index.ts";
import type { PeopleService } from "../people/index.ts";
import type { PluginRegistry, PluginsService } from "../plugins/index.ts";
import * as repo from "./grants.repository.ts";

const DAY_MS = 86_400_000;
const REMINDER_JOB = "grants:deadline_reminders";
/** Reminders before a deadline: 14 days ahead, then 3 (each sent once). */
const REMINDER_DAYS = [14, 3] as const;
const LOCALES = ["sv", "en", "nb"] as const;

/** A plugin's texts in the caller's language (English when it is not one of the plugin's). */
export const textsOf = (plugin: Plugin, locale: string): Record<string, string> =>
  plugin.manifest.texts[(LOCALES as readonly string[]).includes(locale) ? (locale as "sv") : "en"];

/** The stored evaluation of a report: the plugin's result plus the sessions' titles and dates. */
export interface StoredEvaluation {
  basis: "session" | "membership_snapshot" | "leader";
  period: Period;
  evaluation: PeriodEvaluation | null;
  snapshot: Snapshot | null;
  /** The sessions as the plugin saw them (IDs only), with their titles for the view. */
  sessions: (PluginSession & { title: string })[];
}

/** One session for the attendance view's hint. */
export interface HintInput {
  activityId: string;
  startsAt: Date;
  endsAt: Date;
  participantIds: readonly string[];
  leaderIds: readonly string[];
}

const minutes = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / 60_000);

export class GrantsService {
  private readonly db: Database;
  private readonly plugins: PluginsService;
  private readonly registry: PluginRegistry;
  private readonly people: PeopleService;
  private readonly clubs: ClubsService;

  constructor(
    db: Database,
    deps: {
      plugins: PluginsService;
      registry: PluginRegistry;
      people: PeopleService;
      clubs: ClubsService;
    },
  ) {
    this.db = db;
    this.plugins = deps.plugins;
    this.registry = deps.registry;
    this.people = deps.people;
    this.clubs = deps.clubs;
  }

  /** The club's enabled grant plugins. */
  private async grantPlugins(context: TenantContext): Promise<Plugin[]> {
    const enabled = await this.plugins.enabledPluginIds(context);
    return enabled.flatMap((id) => {
      const plugin = this.registry.get(id);
      return plugin?.grantReporting ? [plugin] : [];
    });
  }

  private pluginOf(pluginId: string): Plugin {
    const plugin = this.registry.get(pluginId);
    if (!plugin?.grantReporting) throw new DomainError("plugin_not_installed");
    return plugin;
  }

  /** The schemes of the enabled grant plugins with last year's and this year's periods. */
  async schemes(context: TenantContext, locale: string, year: number): Promise<GrantSchemeList> {
    const out: GrantSchemeList = { items: [], unavailable: [] };
    for (const plugin of await this.grantPlugins(context)) {
      const result = await this.plugins.run(
        context,
        plugin.manifest.id,
        async (p, ctx) => {
          const schemes = await p.grantReporting!.schemes(ctx);
          return Promise.all(
            schemes.map(async (scheme) => ({
              scheme,
              periods: [
                ...(await p.grantReporting!.periods(ctx, scheme.key, year - 1)),
                ...(await p.grantReporting!.periods(ctx, scheme.key, year)),
              ],
            })),
          );
        },
        z.array(z.object({ scheme: SchemeSchema, periods: z.array(PeriodSchema) })),
      );
      if (!result.ok) {
        out.unavailable.push(plugin.manifest.id);
        continue;
      }
      const texts = textsOf(plugin, locale);
      for (const { scheme, periods } of result.value) {
        out.items.push({
          pluginId: plugin.manifest.id,
          key: scheme.key,
          name: texts[scheme.name] ?? scheme.name,
          basis: scheme.basis,
          formats: [...scheme.formats],
          integration: scheme.integration,
          periods,
        });
      }
    }
    return out;
  }

  /** The scheme and period as the plugin defines them. */
  private async schemeAndPeriod(
    context: TenantContext,
    plugin: Plugin,
    schemeKey: string,
    periodKey: string,
  ) {
    const year = Number(periodKey.slice(0, 4));
    if (!Number.isInteger(year) || year < 2000) throw new DomainError("grant_period_unknown");
    const result = await this.plugins.run(
      context,
      plugin.manifest.id,
      async (p, ctx) => ({
        schemes: await p.grantReporting!.schemes(ctx),
        periods: await p.grantReporting!.periods(ctx, schemeKey, year),
      }),
      z.object({ schemes: z.array(SchemeSchema), periods: z.array(PeriodSchema) }),
    );
    if (!result.ok) throw new DomainError("plugin_unavailable");
    const scheme = result.value.schemes.find((s) => s.key === schemeKey);
    const period = result.value.periods.find((p) => p.key === periodKey);
    if (!scheme || !period) throw new DomainError("grant_period_unknown");
    return { scheme, period };
  }

  /** The people as a plugin may see them (only the declared fields). */
  private async peopleFor(
    tx: Tx,
    plugin: Plugin,
    ids: readonly string[],
    date: string,
    timeZone: string,
    options: { identityNumbers: boolean },
  ): Promise<PluginPerson[]> {
    const declared = plugin.manifest.data;
    const rows = await repo.peopleData(tx, ids);
    const groups = await repo.groupsOn(tx, ids, date);
    const identities = await this.people.grantIdentitiesInTx(tx, ids, {
      identityNumbers: options.identityNumbers && declared.includes("personalIdentityNumber"),
    });
    return rows.flatMap((r) => {
      const identity = identities.get(r.id);
      if (!identity) return [];
      const own = groups.filter((g) => g.personId === r.id);
      const byGroup = new Map<
        string,
        { groupId: string; functions: string[]; sport: string | null; adapted: boolean }
      >();
      for (const g of own) {
        const entry = byGroup.get(g.groupId) ?? {
          groupId: g.groupId,
          functions: [],
          sport: g.sport,
          adapted: g.adapted,
        };
        entry.functions.push(g.function);
        byGroup.set(g.groupId, entry);
      }
      const m = r.membership;
      const full: PluginPerson = {
        id: r.id,
        ...identity,
        disability: own.some((g) => g.adapted),
        homeMunicipality: null,
        membership: m
          ? {
              status: m.status === "applied" ? "active" : m.status,
              type: m.type === "active" ? "active" : "passive",
              joinedOn: localDate(m.validFrom, timeZone),
              leftOn: m.validTo ? localDate(m.validTo, timeZone) : null,
            }
          : null,
        // Member fees come with Phase 3; until then the club does not keep them here.
        membershipFeePaid: null,
        clubRoles: [],
        groups: [...byGroup.values()],
      };
      return [minimizePerson(full, declared)];
    });
  }

  /** The sessions of a period and the people in them, or the members on the reference date. */
  private collect(
    context: TenantContext,
    plugin: Plugin,
    basis: StoredEvaluation["basis"],
    period: Period,
  ): Promise<{ sessions: PluginSession[]; people: PluginPerson[]; titles: Map<string, string> }> {
    return this.db.withTenant(context, async (tx) => {
      const club = await this.clubs.getClubInTx(tx, context.clubId);
      if (basis === "membership_snapshot") {
        const date = period.referenceDate ?? period.to;
        const ids = await repo.membersOn(tx, date);
        const people = await this.peopleFor(tx, plugin, ids, date, club.timeZone, {
          identityNumbers: true,
        });
        return { sessions: [], people, titles: new Map() };
      }
      // A day either side covers every time zone; the local date decides.
      const rows = (
        await repo.heldSessions(tx, {
          from: new Date(Date.parse(`${period.from}T00:00:00Z`) - DAY_MS),
          to: new Date(Date.parse(`${period.to}T00:00:00Z`) + 2 * DAY_MS),
        })
      ).filter((s) => {
        const date = localDate(s.startsAt, club.timeZone);
        return date >= period.from && date <= period.to;
      });
      const present = await repo.present(
        tx,
        rows.map((r) => r.activityId),
      );
      const ids = [...new Set(present.map((p) => p.personId))];
      const people = await this.peopleFor(tx, plugin, ids, period.to, club.timeZone, {
        identityNumbers: true,
      });
      const sessions = rows.map((s) =>
        minimizeSession(
          {
            id: s.activityId,
            groupId: s.groupId,
            sport: s.sport,
            adapted: s.adapted,
            kind: s.kind,
            date: localDate(s.startsAt, club.timeZone),
            startsAt: s.startsAt.toISOString(),
            durationMinutes: minutes(s.startsAt, s.endsAt),
            participantIds: present
              .filter((p) => p.activityId === s.activityId && p.role === "participant")
              .map((p) => p.personId),
            leaderIds: present
              .filter((p) => p.activityId === s.activityId && p.role === "leader")
              .map((p) => p.personId),
          },
          plugin.manifest.data,
        ),
      );
      return { sessions, people, titles: new Map(rows.map((r) => [r.activityId, r.title])) };
    });
  }

  /** A period's report: evaluated again while a draft, as stored once locked. */
  async report(
    context: TenantContext,
    key: { pluginId: string; scheme: string; period: string },
  ): Promise<{ row: repo.ReportRow; stored: StoredEvaluation; plugin: Plugin }> {
    const plugin = this.pluginOf(key.pluginId);
    const existing = await this.db.withTenant(context, (tx) => repo.reportByKey(tx, key));
    if (existing && existing.status !== "draft") {
      return { row: existing, stored: existing.evaluation as StoredEvaluation, plugin };
    }
    const { scheme, period } = await this.schemeAndPeriod(context, plugin, key.scheme, key.period);
    const data = await this.collect(context, plugin, scheme.basis, period);
    let evaluation: PeriodEvaluation | null = null;
    let snapshot: Snapshot | null = null;
    if (scheme.basis === "membership_snapshot") {
      const result = await this.plugins.run(
        context,
        key.pluginId,
        (p, ctx) => p.grantReporting!.snapshot!(ctx, key.scheme, period, data.people),
        SnapshotSchema,
      );
      if (!result.ok) throw new DomainError("plugin_unavailable");
      snapshot = result.value;
    } else {
      const result = await this.plugins.run(
        context,
        key.pluginId,
        (p, ctx) =>
          p.grantReporting!.evaluatePeriod!(ctx, key.scheme, period, data.sessions, data.people),
        PeriodEvaluationSchema,
      );
      if (!result.ok) throw new DomainError("plugin_unavailable");
      evaluation = result.value;
    }
    const stored: StoredEvaluation = {
      basis: scheme.basis,
      period,
      evaluation,
      snapshot,
      sessions: data.sessions.map((s) => ({ ...s, title: data.titles.get(s.id) ?? "" })),
    };
    const row = await this.db.withTenant(context, (tx) =>
      repo.saveDraft(
        tx,
        { ...key, from: period.from, to: period.to },
        stored,
        (evaluation ?? snapshot)?.totals ?? [],
      ),
    );
    return {
      row,
      stored: row.status === "draft" ? stored : (row.evaluation as StoredEvaluation),
      plugin,
    };
  }

  /** Locks a draft (its evaluation is kept as it is). */
  lock(context: TenantContext, reportId: string): Promise<void> {
    return this.db.withTenant(context, async (tx) => {
      const report = await repo.report(tx, reportId);
      if (!report) throw new DomainError("not_found");
      if (!(await repo.lock(tx, reportId, context.personId ?? null))) {
        throw new DomainError("grant_report_locked");
      }
      await audit.record(tx, {
        action: "grant.report.locked",
        resourceType: "club",
        resourceId: context.clubId,
        changedFields: [report.pluginId, report.schemeKey, report.periodKey],
      });
    });
  }

  /** A locked report's files from its plugin. */
  async export(
    context: TenantContext,
    reportId: string,
    format: "csv" | "pdf" | "xml" | "json",
  ): Promise<{ name: string; mediaType: string; content: string }[]> {
    const row = await this.db.withTenant(context, (tx) => repo.report(tx, reportId));
    if (!row) throw new DomainError("not_found");
    if (row.status === "draft") throw new DomainError("grant_report_not_locked");
    const plugin = this.pluginOf(row.pluginId);
    const stored = row.evaluation as StoredEvaluation;
    // The people again with their declared data (the report stores IDs only).
    const ids = new Set<string>();
    for (const s of stored.evaluation?.sessions ?? []) {
      for (const id of s.countedPersonIds) ids.add(id);
    }
    for (const p of stored.evaluation?.people ?? []) ids.add(p.personId);
    for (const p of stored.snapshot?.people ?? []) ids.add(p.personId);
    const people = await this.db.withTenant(context, async (tx) => {
      const club = await this.clubs.getClubInTx(tx, context.clubId);
      return this.peopleFor(tx, plugin, [...ids], stored.period.to, club.timeZone, {
        identityNumbers: false,
      });
    });
    const report: PluginReport = {
      id: row.id,
      scheme: row.schemeKey,
      period: stored.period,
      evaluation: stored.evaluation,
      snapshot: stored.snapshot,
      people,
      sessions: stored.sessions.map(({ title: _title, ...session }) => session),
    };
    const result = await this.plugins.run(
      context,
      row.pluginId,
      (p, ctx) => p.grantReporting!.export(ctx, row.schemeKey, report, format),
      z.array(ExportFileSchema),
    );
    if (!result.ok) throw new DomainError("plugin_unavailable");
    await this.db.withTenant(context, async (tx) => {
      await repo.markExported(tx, reportId);
      await audit.record(tx, {
        action: "grant.report.exported",
        resourceType: "club",
        resourceId: context.clubId,
        changedFields: [row.pluginId, row.schemeKey, row.periodKey, format],
      });
    });
    return result.value;
  }

  /**
   * Hints for the attendance view (the plugin's single-session evaluation)
   * from the club's enabled session-based grant plugins; computed without
   * personal identity numbers. Codes `scheme.code` become `{ scheme, code }`.
   */
  async sessionHints(
    context: TenantContext,
    inputs: readonly HintInput[],
  ): Promise<Map<string, GrantHint[]>> {
    const result = new Map<string, GrantHint[]>();
    if (inputs.length === 0) return result;
    const plugins = (await this.grantPlugins(context)).filter(
      (p) => p.grantReporting!.evaluateSession,
    );
    for (const plugin of plugins) {
      const ids = [...new Set(inputs.flatMap((i) => [...i.participantIds, ...i.leaderIds]))];
      const data = await this.db.withTenant(context, async (tx) => {
        const club = await this.clubs.getClubInTx(tx, context.clubId);
        const groups = await repo.sessionGroups(
          tx,
          inputs.map((i) => i.activityId),
        );
        const today = localDate(new Date(), club.timeZone);
        const people = await this.peopleFor(tx, plugin, ids, today, club.timeZone, {
          identityNumbers: false,
        });
        const sessions = inputs.flatMap((i) => {
          const g = groups.get(i.activityId);
          if (!g) return [];
          return [
            minimizeSession(
              {
                id: i.activityId,
                groupId: g.groupId,
                sport: g.sport,
                adapted: g.adapted,
                kind: "training",
                date: localDate(i.startsAt, club.timeZone),
                startsAt: i.startsAt.toISOString(),
                durationMinutes: minutes(i.startsAt, i.endsAt),
                participantIds: [...i.participantIds],
                leaderIds: [...i.leaderIds],
              },
              plugin.manifest.data,
            ),
          ];
        });
        return { people, sessions };
      });
      const evaluations = await this.plugins.run(
        context,
        plugin.manifest.id,
        async (p, ctx) => {
          const scheme = (await p.grantReporting!.schemes(ctx)).find((s) => s.basis === "session");
          if (!scheme) return [];
          return Promise.all(
            data.sessions.map((s) =>
              p.grantReporting!.evaluateSession!(ctx, scheme.key, s, data.people),
            ),
          );
        },
        z.array(SessionEvaluationSchema),
      );
      if (!evaluations.ok) continue;
      for (const e of evaluations.value) {
        const hints = result.get(e.sessionId) ?? [];
        for (const full of e.codes) {
          const dot = full.indexOf(".");
          hints.push({ scheme: full.slice(0, dot), code: full.slice(dot + 1) });
        }
        result.set(e.sessionId, hints);
      }
    }
    return result;
  }

  /**
   * Deadline reminders (daily, an API job): for every club's enabled grant
   * plugin, last year's and this year's periods whose deadline is 14 or 3
   * days away (in the club's time zone) and whose report is not locked yet
   * get a `grant.deadline.near` event, once per stage (idempotency key).
   * Returns the events published.
   */
  async remindDeadlines(now: Date = new Date()): Promise<number> {
    const enabled = await this.plugins.enabledPluginsOfAllClubs(REMINDER_JOB);
    let published = 0;
    for (const { clubId, pluginId } of enabled) {
      if (!this.registry.get(pluginId)?.grantReporting) continue;
      const year = now.getUTCFullYear();
      const result = await this.plugins.run(
        { system: REMINDER_JOB, clubId },
        pluginId,
        async (p, ctx) => {
          const out: { scheme: string; period: Period }[] = [];
          for (const scheme of await p.grantReporting!.schemes(ctx)) {
            for (const y of [year - 1, year]) {
              for (const period of await p.grantReporting!.periods(ctx, scheme.key, y)) {
                out.push({ scheme: scheme.key, period });
              }
            }
          }
          return out;
        },
        z.array(z.object({ scheme: z.string(), period: PeriodSchema })),
      );
      if (!result.ok) continue;
      published += await this.db.withSystem(REMINDER_JOB, { clubId }, async (tx) => {
        const club = await this.clubs.getClubInTx(tx, clubId);
        const today = localDate(now, club.timeZone);
        let count = 0;
        for (const { scheme, period } of result.value) {
          const days = Math.round(
            (Date.parse(`${period.deadline}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) /
              DAY_MS,
          );
          // The nearest stage not yet passed: 14 days (4–14 left), then 3 (0–3 left).
          const stage = [...REMINDER_DAYS].reverse().find((d) => days >= 0 && days <= d);
          if (stage === undefined || period.from > today) continue;
          const report = await repo.reportByKey(tx, { pluginId, scheme, period: period.key });
          if (report && report.status !== "draft") continue;
          await outbox.publish(
            tx,
            "grant.deadline.near",
            {
              clubId,
              pluginId,
              scheme,
              period: period.key,
              deadline: period.deadline,
              days: stage,
            },
            {
              idempotencyKey: `grant.deadline:${clubId}:${pluginId}:${scheme}:${period.key}:${stage}`,
            },
          );
          count += 1;
        }
        return count;
      });
    }
    return published;
  }
}
