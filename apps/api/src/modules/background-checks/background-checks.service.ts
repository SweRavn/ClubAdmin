// SPDX-License-Identifier: AGPL-3.0-only
// Background checks (P2.8, ADR 0051 decision 6, ADR 0047 rule 6 amended).
// The plugin of the club's country is the source of the requirements (on by
// default; a club that turns it off lifts every requirement); the club may
// only add stricter ones. Roles carry who needs a check; duty types map to a
// category through their contact with children. A record says that someone
// in the club saw a certificate: type, dates, how, by whom; never the
// document, a code or a negative outcome (a negative outcome is not entered:
// the role ends without a reason). Records are kept until someone deletes
// them; the overview lists those no role needs any more.
//
// The plugins' declarations (types, requirements) are read once per process
// (the contract makes them static), so chat and duties enforce the rules
// inside their own transaction with one query (`personFacts`).

import { audit, type Database, outbox, type TenantContext, type Tx } from "@clubadmin/db";
import {
  CheckResultSchema,
  CheckTypeSchema,
  type Plugin,
  PresentedOutcomeSchema,
  RequestStateSchema,
  RequirementSchema,
} from "@clubadmin/plugin-api";
import {
  type BackgroundCheckCategory,
  type BackgroundCheckClubRequirement,
  type CreateBackgroundCheckRecordInput,
  CreateBackgroundCheckRecordSchema,
  type CreateBackgroundCheckRequestInput,
  DUTY_CONTACT_CATEGORY,
  localDate,
  type PutBackgroundCheckRequirementsInput,
  PutBackgroundCheckRequirementsSchema,
  z,
} from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { actorPersonId, parseInput } from "../../platform/domain/run.ts";
import { ProblemError } from "../../platform/http/problem-error.ts";
import type { PluginRegistry, PluginsService } from "../plugins/index.ts";
import * as repo from "./background-checks.repository.ts";
import {
  addDays,
  addMonths,
  type ClubRules,
  clubRules,
  type Coverage,
  coverage,
  expiresOn,
  overviewStatus,
  type PluginDeclarations,
  pluginForCountry,
  weakerCategory,
  weakerThanPlugin,
} from "./background-checks.rules.ts";

/** Records nobody needs are listed for deletion this long after the last role that needed one. */
export const DELETE_AFTER_MONTHS = 12;
/** A check counts as expiring this many days before it ends (overview, reminders). */
export const EXPIRING_DAYS = 60;
/** Reminders to the person: 60 days and 14 days before a check ends. */
export const REMINDER_DAYS = [EXPIRING_DAYS, 14] as const;
const REMINDER_JOB = "background_checks:reminders";

/** The ISO week of a date (`2026-W48`), for the weekly follow-up's key. */
export function isoWeek(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

const LOCALES = ["sv", "en", "nb"] as const;
const textsIn = (plugin: Plugin, locale: string) =>
  plugin.manifest.texts[(LOCALES as readonly string[]).includes(locale) ? (locale as "sv") : "en"];

export interface OverviewEntry {
  personId: string;
  status: "missing" | "expiring" | "valid" | "to_delete";
  categories: BackgroundCheckCategory[];
  expiresOn: string | null;
  records: repo.RecordRow[];
  request: repo.OverviewRow["request"];
}

export class BackgroundChecksService {
  private readonly db: Database;
  private readonly registry: PluginRegistry;
  private readonly plugins: PluginsService | undefined;
  private readonly now: () => Date;
  private catalogueLoad: Promise<PluginDeclarations[]> | null = null;

  constructor(
    db: Database,
    /** Without `plugins` (the seed's and tests' services) records and requests cannot be made. */
    deps: { registry: PluginRegistry; plugins?: PluginsService; now?: () => Date },
  ) {
    this.db = db;
    this.registry = deps.registry;
    this.plugins = deps.plugins;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * The installed background-check plugins' declarations, read once (a
   * neutral context: no club, no network, no state, as the contract says).
   */
  catalogue(): Promise<PluginDeclarations[]> {
    this.catalogueLoad ??= Promise.all(
      this.registry
        .all()
        .filter((p) => p.backgroundChecks)
        .map(async (p) => {
          const region = p.manifest.regions[0] ?? "SE";
          const ctx = {
            club: {
              id: "00000000-0000-0000-0000-000000000000",
              country: region,
              timeZone: "UTC",
              locale: "en",
            },
            config: {},
            secrets: {},
            now: this.now,
            log: { info: () => undefined, warn: () => undefined, error: () => undefined },
            http: {
              request: () => Promise.reject(new Error("declarations make no requests")),
            },
            state: {
              get: () => Promise.resolve(null),
              set: () => Promise.resolve(),
              delete: () => Promise.resolve(),
            },
          };
          return {
            pluginId: p.manifest.id,
            regions: [...p.manifest.regions],
            types: z.array(CheckTypeSchema).parse(await p.backgroundChecks!.checkTypes(ctx)),
            requirements: z
              .array(RequirementSchema)
              .parse(await p.backgroundChecks!.requirements(ctx)),
          };
        }),
    );
    return this.catalogueLoad;
  }

  private today(timeZone: string): string {
    return localDate(this.now(), timeZone);
  }

  /** The club's effective rules in a transaction of the caller's (one statement). */
  async rulesInTx(tx: Tx, clubId: string): Promise<{ rules: ClubRules; facts: repo.ClubFacts }> {
    const catalogue = await this.catalogue();
    const facts = await repo.clubFacts(tx, clubId);
    return {
      facts,
      rules: clubRules(catalogue, facts.country, facts.disabledPluginIds, facts.clubRequirements),
    };
  }

  // --- Enforcement (chat, duties) -------------------------------------------------------

  /**
   * Whether the person may be with children through the roles they hold
   * (ADR 0047 rule 9: writing to children, joining their chats): true unless
   * a role needs a check the club requires and they have no valid one. One
   * statement in the caller's transaction.
   */
  async childContactAllowedInTx(tx: Tx, clubId: string, personId: string): Promise<boolean> {
    const catalogue = await this.catalogue();
    const f = await repo.personFacts(tx, clubId, personId);
    const rules = clubRules(
      catalogue,
      f.club.country,
      f.club.disabledPluginIds,
      f.club.clubRequirements,
    );
    const c = coverage(
      rules,
      f.needs.map((n) => n.category),
      f.records,
      this.today(f.club.timeZone),
    );
    return c.status !== "missing";
  }

  /** The category a duty type needs (its stricter mapping, else its contact with children). */
  static dutyCategory(type: {
    childContact: "none" | "with_children" | "alone_with_children";
    category: BackgroundCheckCategory | null;
  }): BackgroundCheckCategory | null {
    return type.category ?? DUTY_CONTACT_CATEGORY[type.childContact];
  }

  /**
   * The people of `personIds` who lack a valid check for the category (a
   * duty's), in the caller's transaction: two statements, whatever the count.
   */
  async lackingInTx(
    tx: Tx,
    clubId: string,
    personIds: readonly string[],
    category: BackgroundCheckCategory | null,
  ): Promise<Set<string>> {
    if (category === null || personIds.length === 0) return new Set();
    const { rules, facts } = await this.rulesInTx(tx, clubId);
    if (!rules.active || !rules.rules.some((r) => r.category === category)) return new Set();
    const records = await repo.recordsOf(tx, clubId, personIds);
    const today = this.today(facts.timeZone);
    return new Set(
      personIds.filter(
        (id) =>
          coverage(
            rules,
            [category],
            records.filter((r) => r.personId === id),
            today,
          ).status === "missing",
      ),
    );
  }

  /** Refuses a duty that needs a check the person lacks (sign-up, assignment, a swap). */
  async requireForDutyInTx(
    tx: Tx,
    clubId: string,
    personId: string,
    category: BackgroundCheckCategory | null,
  ): Promise<void> {
    if ((await this.lackingInTx(tx, clubId, [personId], category)).size > 0) {
      throw new DomainError("background_check_required");
    }
  }

  // --- Reminders ------------------------------------------------------------------------

  /**
   * Daily (an API job): in every club whose background-check plugin is on,
   * a `background_check.expiring` event per person whose check ends in 60
   * or 14 days (once per stage), and once a week a `follow_up` with the
   * counts of missing and expiring checks for those who follow up. Returns
   * the events published.
   */
  async remindExpiring(now: Date = new Date()): Promise<number> {
    const catalogue = await this.catalogue();
    const countries = [...new Set(catalogue.flatMap((p) => p.regions.map((r) => r.slice(0, 2))))];
    const clubIds = await this.db.withSystem(REMINDER_JOB, {}, (tx) =>
      repo.activeClubsIn(tx, countries),
    );
    let published = 0;
    for (const clubId of clubIds) {
      published += await this.db.withSystem(REMINDER_JOB, { clubId }, async (tx) => {
        const facts = await repo.clubFacts(tx, clubId);
        const rules = clubRules(
          catalogue,
          facts.country,
          facts.disabledPluginIds,
          facts.clubRequirements,
        );
        if (!rules.active) return 0;
        const today = localDate(now, facts.timeZone);
        let count = 0;
        let missing = 0;
        let expiring = 0;
        for (const row of await repo.overviewRows(tx, clubId)) {
          const c = coverage(rules, row.categories, row.records, today);
          if (c.status === "missing") missing++;
          if (c.status !== "valid" || c.expiresOn === null) continue;
          const days = Math.round(
            (Date.parse(`${c.expiresOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) /
              86_400_000,
          );
          const stage = [...REMINDER_DAYS].reverse().find((d) => days >= 0 && days <= d);
          if (stage === undefined) continue;
          expiring++;
          await outbox.publish(
            tx,
            "background_check.expiring",
            { clubId, personId: row.personId, expiresOn: c.expiresOn, days: stage },
            {
              idempotencyKey: `background_check.expiring:${clubId}:${row.personId}:${c.expiresOn}:${stage}`,
            },
          );
          count++;
        }
        if (missing + expiring > 0) {
          const week = isoWeek(today);
          await outbox.publish(
            tx,
            "background_check.follow_up",
            { clubId, missing, expiring, week },
            { idempotencyKey: `background_check.follow_up:${clubId}:${week}` },
          );
          count++;
        }
        return count;
      });
    }
    return published;
  }

  // --- Follow-up ------------------------------------------------------------------------

  /** Everyone the overview is about, with their status, ordered by person ID. */
  async overview(context: TenantContext): Promise<{ active: boolean; entries: OverviewEntry[] }> {
    return this.db.withTenant(context, async (tx) => {
      const { rules, facts } = await this.rulesInTx(tx, context.clubId);
      const today = this.today(facts.timeZone);
      const rows = await repo.overviewRows(tx, context.clubId);
      const ruleFor = (r: repo.RecordRow) =>
        rules.rules.find((x) => x.pluginId === r.pluginId && x.checkType === r.checkType) ?? {
          category: "regular_contact_with_children" as const,
          pluginId: r.pluginId,
          checkType: r.checkType,
          recheckMonths: null,
        };
      const entries: OverviewEntry[] = [];
      for (const row of rows) {
        const c: Coverage = coverage(rules, row.categories, row.records, today);
        let status = overviewStatus(c, row.records.length > 0, today, EXPIRING_DAYS);
        // Kept until deleted; listed for deletion 12 months after the last role that needed it.
        if (
          status === "to_delete" &&
          row.lastNeededOn !== null &&
          addMonths(row.lastNeededOn, DELETE_AFTER_MONTHS) > today
        ) {
          status = "valid";
        }
        if (status === null && !row.request) continue;
        entries.push({
          personId: row.personId,
          status: status ?? "missing",
          categories: row.categories.filter((cat) => rules.rules.some((r) => r.category === cat)),
          expiresOn: c.status === "valid" ? c.expiresOn : null,
          records: row.records.map((r) => ({ ...r, validUntil: expiresOn(r, ruleFor(r)) })),
          request: row.request,
        });
      }
      return { active: rules.active, entries };
    });
  }

  /** The requirements page: the plugin's, the club's additions, roles and duty types. */
  async requirements(context: TenantContext, locale: string) {
    const catalogue = await this.catalogue();
    return this.db.withTenant(context, async (tx) => {
      const facts = await repo.clubFacts(tx, context.clubId);
      const plugin = pluginForCountry(catalogue, facts.country);
      const installed = plugin ? this.registry.get(plugin.pluginId) : undefined;
      const text = (key: string) => (installed ? (textsIn(installed, locale)[key] ?? key) : key);
      const [roles, dutyTypes] = await Promise.all([
        repo.rolesWithCategories(tx, context.clubId),
        repo.dutyTypes(tx, context.clubId),
      ]);
      return {
        plugin: plugin
          ? { id: plugin.pluginId, enabled: !facts.disabledPluginIds.includes(plugin.pluginId) }
          : null,
        types: (plugin?.types ?? []).map((t) => ({
          pluginId: plugin!.pluginId,
          key: t.key,
          name: text(t.name),
          initiator: t.initiator,
          maxAgeDaysWhenPresented: t.maxAgeDaysWhenPresented,
          recheckMonths: t.recheckMonths,
          minAge: t.minAge,
        })),
        pluginRequirements: (plugin?.requirements ?? []).map((r) => ({
          pluginId: plugin!.pluginId,
          category: r.category,
          checkType: r.checkType,
          level: r.level,
          basis: text(r.basis),
        })),
        clubRequirements: facts.clubRequirements,
        roles,
        dutyTypes: dutyTypes.map((t) => ({
          ...t,
          effectiveCategory: BackgroundChecksService.dutyCategory(t),
        })),
      };
    });
  }

  /** The club's stricter requirements and duty types' mappings; never weaker than the plugin. */
  async putRequirements(
    context: TenantContext,
    input: PutBackgroundCheckRequirementsInput,
  ): Promise<void> {
    const data = parseInput(PutBackgroundCheckRequirementsSchema, input);
    const catalogue = await this.catalogue();
    await this.db.withTenant(context, async (tx) => {
      const facts = await repo.clubFacts(tx, context.clubId);
      const plugin = pluginForCountry(catalogue, facts.country);
      const additions: BackgroundCheckClubRequirement[] = [];
      const seen = new Set<string>();
      for (const [i, r] of data.clubRequirements.entries()) {
        if (!plugin || r.pluginId !== plugin.pluginId)
          throw fieldError(`clubRequirements.${i}.pluginId`, "background_check_type_unknown");
        if (!plugin.types.some((t) => t.key === r.checkType)) {
          throw fieldError(`clubRequirements.${i}.checkType`, "background_check_type_unknown");
        }
        if (weakerThanPlugin(plugin, r)) {
          throw fieldError(`clubRequirements.${i}.recheckMonths`, "background_check_weaker");
        }
        const key = `${r.category}:${r.checkType}`;
        if (seen.has(key)) continue;
        seen.add(key);
        additions.push(r);
      }
      const types = new Map((await repo.dutyTypes(tx, context.clubId)).map((t) => [t.id, t]));
      for (const [i, d] of data.dutyTypes.entries()) {
        const type = types.get(d.id);
        if (!type) throw fieldError(`dutyTypes.${i}.id`, "not_found");
        if (weakerCategory(DUTY_CONTACT_CATEGORY[type.childContact], d.category)) {
          throw fieldError(`dutyTypes.${i}.category`, "background_check_weaker");
        }
      }
      const before = JSON.stringify(facts.clubRequirements);
      await repo.replaceClubRequirements(tx, context.clubId, additions);
      const changed: string[] = [];
      if (before !== JSON.stringify(additions)) changed.push("club_requirements");
      for (const d of data.dutyTypes) {
        if (await repo.setDutyTypeCategory(tx, context.clubId, d.id, d.category)) {
          changed.push(`duty_type:${d.id}`);
        }
      }
      if (changed.length) {
        await audit.record(tx, {
          action: "background_check.requirements_changed",
          resourceType: "club",
          resourceId: context.clubId,
          changedFields: changed,
        });
      }
    });
  }

  /**
   * Ticks off a certificate a person shows (never one's own): the plugin
   * checks what can be checked (its age when shown), nothing of the
   * certificate is kept. Earlier records of the type are superseded; an
   * open request of the type is done.
   */
  async record(
    context: TenantContext,
    input: CreateBackgroundCheckRecordInput,
    locale: string,
  ): Promise<{ id: string; expiresOn: string | null }> {
    const data = parseInput(CreateBackgroundCheckRecordSchema, input);
    const verifier = actorPersonId(context);
    if (data.personId === verifier) throw new DomainError("background_check_own");
    const catalogue = await this.catalogue();
    const { rules, facts } = await this.db.withTenant(context, async (tx) => {
      if (!(await repo.inClub(tx, context.clubId, data.personId))) {
        throw fieldError("personId", "background_check_not_in_club");
      }
      return this.rulesInTx(tx, context.clubId);
    });
    if (!rules.active || rules.pluginId !== data.pluginId) {
      throw new DomainError("background_check_off");
    }
    const declared = catalogue.find((p) => p.pluginId === data.pluginId);
    if (!declared?.types.some((t) => t.key === data.checkType)) {
      throw fieldError("checkType", "background_check_type_unknown");
    }
    if (!this.plugins) throw new DomainError("plugin_unavailable");
    const outcome = await this.plugins.run(
      context,
      data.pluginId,
      (p, ctx) => {
        if (!p.backgroundChecks?.verifyPresented) {
          return Promise.resolve({
            outcome: "not_verified",
            reason: "background_check_type_unknown",
          });
        }
        return p.backgroundChecks.verifyPresented(ctx, {
          personId: data.personId,
          checkType: data.checkType,
          issuedOn: data.issuedOn,
          method: data.method,
        });
      },
      PresentedOutcomeSchema,
    );
    if (!outcome.ok) throw new DomainError("plugin_unavailable");
    const value = outcome.value;
    if (value.outcome === "closed") {
      // Never kept: the case closes without a reason (GDPR Art. 10).
      throw new DomainError("background_check_not_verified");
    }
    if (value.outcome === "not_verified") {
      const plugin = this.registry.get(data.pluginId)!;
      throw new ProblemError("validation", {
        detail: "background_check_not_verified",
        errors: [
          {
            location: "body",
            path: "issuedOn",
            code: "background_check_not_verified",
            message: textsIn(plugin, locale)[value.reason] ?? value.reason,
          },
        ],
      });
    }
    const result = CheckResultSchema.parse(value.result);
    const rule = rules.rules.find(
      (r) => r.pluginId === data.pluginId && r.checkType === result.checkType,
    ) ?? {
      category: "regular_contact_with_children" as const,
      ...{ pluginId: data.pluginId, checkType: result.checkType, recheckMonths: null },
    };
    return this.db.withTenant(context, async (tx) => {
      const verifiedOn = this.today(facts.timeZone);
      const created = await repo.insertRecord(tx, context.clubId, {
        personId: data.personId,
        pluginId: data.pluginId,
        checkType: result.checkType,
        issuingCountry: result.issuingCountry,
        issuedOn: result.issuedOn,
        verifiedOn: verifiedOn < result.issuedOn ? result.issuedOn : verifiedOn,
        verifiedByPersonId: verifier,
        method: result.method,
        validUntil: result.validUntil,
      });
      await repo.completeRequests(
        tx,
        context.clubId,
        data.personId,
        data.pluginId,
        result.checkType,
        created.id,
      );
      await audit.record(tx, {
        action: "background_check.recorded",
        resourceType: "person",
        resourceId: data.personId,
        changedFields: [
          "check_type",
          "issued_on",
          "method",
          ...(created.superseded ? ["superseded"] : []),
        ],
      });
      return {
        id: created.id,
        expiresOn: expiresOn(
          {
            id: created.id,
            pluginId: data.pluginId,
            checkType: result.checkType,
            issuedOn: result.issuedOn,
            validUntil: result.validUntil,
          },
          rule,
        ),
      };
    });
  }

  /**
   * A record without a plugin call: the demo seed and the tests (the follow-up
   * a club kept before ClubAdmin). Never offered by the API.
   */
  recordDirect(
    context: TenantContext,
    values: {
      personId: string;
      pluginId: string;
      checkType: string;
      issuingCountry: string;
      issuedOn: string;
      method?: "viewed" | "digital_mailbox";
    },
  ): Promise<string> {
    return this.db.withTenant(context, async (tx) => {
      const created = await repo.insertRecord(tx, context.clubId, {
        ...values,
        method: values.method ?? "viewed",
        verifiedOn: values.issuedOn,
        verifiedByPersonId: actorPersonId(context),
        validUntil: null,
      });
      await audit.record(tx, {
        action: "background_check.recorded",
        resourceType: "person",
        resourceId: values.personId,
        changedFields: ["check_type", "issued_on", "method"],
      });
      return created.id;
    });
  }

  /** Deletes a record (audited); nothing is deleted automatically (P2.8). */
  deleteRecord(context: TenantContext, recordId: string): Promise<void> {
    return this.db.withTenant(context, async (tx) => {
      const record = await repo.getRecord(tx, context.clubId, recordId);
      if (!record) throw new DomainError("not_found");
      await repo.deleteRecord(tx, context.clubId, recordId);
      await audit.record(tx, {
        action: "background_check.deleted",
        resourceType: "person",
        resourceId: record.personId,
        changedFields: ["background_check"],
      });
    });
  }

  /** Starts a request the club initiates (Norway: the confirmation of purpose). */
  async request(
    context: TenantContext,
    input: CreateBackgroundCheckRequestInput,
  ): Promise<{ id: string; status: string }> {
    const requester = actorPersonId(context);
    const catalogue = await this.catalogue();
    const { rules } = await this.db.withTenant(context, async (tx) => {
      if (!(await repo.inClub(tx, context.clubId, input.personId))) {
        throw fieldError("personId", "background_check_not_in_club");
      }
      return this.rulesInTx(tx, context.clubId);
    });
    if (!rules.active || rules.pluginId !== input.pluginId) {
      throw new DomainError("background_check_off");
    }
    const type = catalogue
      .find((p) => p.pluginId === input.pluginId)
      ?.types.find((t) => t.key === input.checkType);
    if (!type || type.initiator !== "club") {
      throw fieldError("checkType", "background_check_type_unknown");
    }
    if (!this.plugins) throw new DomainError("plugin_unavailable");
    const started = await this.plugins.run(
      context,
      input.pluginId,
      (p, ctx) =>
        p.backgroundChecks?.startRequest
          ? p.backgroundChecks.startRequest(ctx, {
              personId: input.personId,
              checkType: input.checkType,
            })
          : Promise.reject(new Error("no request flow")),
      RequestStateSchema,
    );
    if (!started.ok) throw new DomainError("plugin_unavailable");
    return this.db.withTenant(context, async (tx) => {
      const id = await repo.insertRequest(tx, context.clubId, {
        personId: input.personId,
        pluginId: input.pluginId,
        checkType: input.checkType,
        status: started.value.status,
        reference: started.value.reference,
        requestedByPersonId: requester,
      });
      await audit.record(tx, {
        action: "background_check.requested",
        resourceType: "person",
        resourceId: input.personId,
        changedFields: ["check_type", "status"],
      });
      return { id, status: started.value.status };
    });
  }

  /** My status in a club: what my roles need, my records, how to get a check. */
  async mine(context: TenantContext, locale: string) {
    const personId = actorPersonId(context);
    const catalogue = await this.catalogue();
    return this.db.withTenant(context, async (tx) => {
      const f = await repo.personFacts(tx, context.clubId, personId);
      const rules = clubRules(
        catalogue,
        f.club.country,
        f.club.disabledPluginIds,
        f.club.clubRequirements,
      );
      const today = this.today(f.club.timeZone);
      const categories = [...new Set(f.needs.map((n) => n.category))];
      const c = coverage(rules, categories, f.records, today);
      const plugin = rules.pluginId ? this.registry.get(rules.pluginId) : undefined;
      const declared = catalogue.find((p) => p.pluginId === rules.pluginId);
      const text = (key: string) => (plugin ? (textsIn(plugin, locale)[key] ?? key) : key);
      const roles = new Map(
        (await repo.rolesWithCategories(tx, context.clubId)).map((r) => [r.id, r]),
      );
      const roleName = (id: string) => {
        const r = roles.get(id);
        return r ? (r.names?.[locale] ?? r.names?.sv ?? r.names?.en ?? r.templateKey ?? "") : "";
      };
      const required = rules.rules
        .filter((r) => categories.includes(r.category))
        .map((r) => ({
          category: r.category,
          checkTypeName: text(
            declared?.types.find((t) => t.key === r.checkType)?.name ?? r.checkType,
          ),
          basis: text(
            declared?.requirements.find(
              (x) => x.category === r.category && x.checkType === r.checkType,
            )?.basis ?? "",
          ),
          because: f.needs.filter((n) => n.category === r.category).map((n) => roleName(n.roleId)),
        }));
      const status =
        c.status === "not_required"
          ? ("not_required" as const)
          : c.status === "missing"
            ? ("missing" as const)
            : c.expiresOn !== null && c.expiresOn <= addDays(today, EXPIRING_DAYS)
              ? ("expiring" as const)
              : ("valid" as const);
      const ruleFor = (r: repo.RecordRow) =>
        rules.rules.find((x) => x.pluginId === r.pluginId && x.checkType === r.checkType) ?? {
          category: "regular_contact_with_children" as const,
          pluginId: r.pluginId,
          checkType: r.checkType,
          recheckMonths: null,
        };
      return {
        clubId: context.clubId,
        active: rules.active,
        status,
        required,
        expiresOn: c.status === "valid" ? c.expiresOn : null,
        records: f.records.map((r) => ({ ...r, validUntil: expiresOn(r, ruleFor(r)) })),
        howTo: (declared?.types ?? []).map((t) => ({
          name: text(t.name),
          initiator: t.initiator,
          maxAgeDaysWhenPresented: t.maxAgeDaysWhenPresented,
          minAge: t.minAge,
        })),
        typeName: (r: { pluginId: string; checkType: string }) =>
          text(
            catalogue
              .find((p) => p.pluginId === r.pluginId)
              ?.types.find((t) => t.key === r.checkType)?.name ?? r.checkType,
          ),
      };
    });
  }

  /** A record's type name in a language. */
  async typeName(pluginId: string, checkType: string, locale: string): Promise<string> {
    const declared = (await this.catalogue()).find((p) => p.pluginId === pluginId);
    const plugin = this.registry.get(pluginId);
    const key = declared?.types.find((t) => t.key === checkType)?.name ?? checkType;
    return plugin ? (textsIn(plugin, locale)[key] ?? key) : key;
  }
}

function fieldError(path: string, code: string): ProblemError {
  return new ProblemError("validation", {
    detail: "invalid_input",
    errors: [{ location: "body", path, code, message: code }],
  });
}
