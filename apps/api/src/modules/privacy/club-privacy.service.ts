// SPDX-License-Identifier: AGPL-3.0-only
// The club's privacy settings, the board's decisions on them and the
// club's privacy policy (P1.8a, ADR 0037, ADR 0041). Settings the board
// decides (club-settings.ts) change only through a recorded decision: a
// club manager records the body, the date, the minutes' reference and when
// it takes effect; ClubAdmin records it and does not judge whether the
// meeting followed the statutes. A decision in effect today is applied at
// once, a later one by the worker (clubs:apply_decisions). Each applied
// decision publishes the next version of the policy, and the members are
// told.

import { getCountryPack, isSupportedCountry } from "@clubadmin/country-packs";
import { audit, type Database, outbox, sql, type TenantContext, type Tx } from "@clubadmin/db";
import {
  BOARD_SETTING_KEYS,
  type BoardSettingKey,
  CLUB_SETTINGS,
  localDate,
  PRIVACY_POLICY_TEMPLATE_VERSION,
  type RecordDecisionInput,
  RecordDecisionSchema,
  settingValueSchema,
} from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { actorPersonId, parseInput } from "../../platform/domain/run.ts";
import type { Club, ClubsService } from "../clubs/index.ts";
import * as repo from "./privacy.repository.ts";

export type Decision = repo.DecisionRow;
export type Policy = repo.PolicyRow;

/** A pack's narrower limits for a registry key (never wider than the registry's). */
export function packLimits(country: string, key: string): { min?: number; max?: number } {
  return isSupportedCountry(country) ? (getCountryPack(country).retentionLimits?.[key] ?? {}) : {};
}

export interface PrivacyOverview {
  club: Club;
  texts: repo.ConsentTextRow[];
  decisions: Map<string, Decision>;
  pending: Decision[];
}

export class ClubPrivacyService {
  private readonly db: Database;
  private readonly clubs: ClubsService;
  private readonly now: () => Date;

  constructor(db: Database, deps: { clubs: ClubsService }, now: () => Date = () => new Date()) {
    this.db = db;
    this.clubs = deps.clubs;
    this.now = now;
  }

  overview(context: TenantContext): Promise<PrivacyOverview> {
    return this.db.withTenant(context, async (tx) => ({
      club: await this.clubs.getClubInTx(tx, context.clubId),
      texts: await repo.latestTexts(tx, [context.clubId]),
      decisions: await repo.decisionsBySetting(tx, context.clubId),
      pending: await repo.pendingDecisions(tx, context.clubId),
    }));
  }

  /**
   * Records a decision of the board (or a meeting) on board settings. The
   * values are checked against the registry and the country pack's limits;
   * one in effect today is applied in this transaction.
   */
  recordDecision(context: TenantContext, input: RecordDecisionInput): Promise<Decision> {
    return this.db.withTenant(context, (tx) => this.recordDecisionInTx(tx, context, input));
  }

  /** Today in the club's time zone (the latest day a decision may be dated). */
  async clubTodayInTx(tx: Tx, clubId: string): Promise<string> {
    const club = await this.clubs.getClubInTx(tx, clubId);
    return localDate(this.now(), club.timeZone);
  }

  /**
   * recordDecision in the caller's transaction: adopting a governing
   * document (P2.4) records the settings its text marks, pointing at the
   * adopted version.
   */
  async recordDecisionInTx(
    tx: Tx,
    context: TenantContext,
    input: RecordDecisionInput,
    documentVersionId: string | null = null,
  ): Promise<Decision> {
    const by = actorPersonId(context);
    const data = parseInput(RecordDecisionSchema, input);
    const club = await this.clubs.lockClubInTx(tx, context.clubId);
    const keys = Object.keys(data.settings);
    if (keys.length === 0) throw new DomainError("decision_invalid");
    const settings: Record<string, unknown> = {};
    for (const key of keys) {
      if (!(BOARD_SETTING_KEYS as readonly string[]).includes(key)) {
        throw new DomainError("decision_invalid");
      }
      const parsed = settingValueSchema(
        key as BoardSettingKey,
        packLimits(club.country, key),
      ).safeParse(data.settings[key]);
      if (!parsed.success) throw new DomainError("decision_invalid");
      settings[key] = parsed.data;
    }
    const today = localDate(this.now(), club.timeZone);
    const effectiveFrom = data.effectiveFrom ?? data.decidedOn;
    if (data.decidedOn > today || effectiveFrom < data.decidedOn) {
      throw new DomainError("decision_invalid");
    }
    const decision = await repo.insertDecision(tx, {
      clubId: context.clubId,
      body: data.body,
      decidedOn: data.decidedOn,
      reference: data.reference,
      effectiveFrom,
      settings,
      recordedByPersonId: by,
      documentVersionId,
    });
    await audit.record(tx, {
      action: "club.settings.decided",
      resourceType: "club_setting_decision",
      resourceId: decision.id,
      changedFields: keys,
    });
    if (effectiveFrom <= today) await applyDecisionInTx(tx, decision.id);
    return (await repo.findDecision(tx, decision.id))!;
  }

  decisions(
    context: TenantContext,
    page: { cursor?: string | undefined; limit: number },
  ): Promise<{ items: Decision[]; nextCursor: string | null }> {
    return this.db.withTenant(context, async (tx) => {
      const rows = await repo.decisionsPage(tx, context.clubId, {
        cursor: page.cursor ?? null,
        limit: page.limit + 1,
      });
      const items = rows.slice(0, page.limit);
      return { items, nextCursor: rows.length > page.limit ? items.at(-1)!.id : null };
    });
  }

  /**
   * The club's policy versions (newest first) with the decisions they rest
   * on. Before the first decision there is no stored version: the current
   * settings are version 1, in effect since the club was created.
   */
  policies(
    context: TenantContext,
  ): Promise<{ club: Club; versions: Policy[]; decisions: Map<string, Decision> }> {
    return this.db.withTenant(context, async (tx) => {
      const club = await this.clubs.getClubInTx(tx, context.clubId);
      const versions = await repo.policies(tx, context.clubId);
      const decisions = new Map<string, Decision>();
      for (const id of new Set(versions.flatMap((v) => (v.decisionId ? [v.decisionId] : [])))) {
        const decision = await repo.findDecision(tx, id);
        if (decision) decisions.set(id, decision);
      }
      if (versions.length === 0) {
        const { rows } = await tx.execute<{ settings: Record<string, unknown> }>(
          sql`SELECT app.policy_settings(c) AS settings FROM public.clubs c WHERE c.id = ${club.id}`,
        );
        versions.push({
          id: club.id,
          clubId: club.id,
          version: 1,
          templateVersion: PRIVACY_POLICY_TEMPLATE_VERSION,
          settings: rows[0]!.settings,
          decisionId: null,
          effectiveFrom: club.createdAt.toISOString().slice(0, 10),
          createdAt: club.createdAt,
          updatedAt: club.createdAt,
        });
      }
      return { club, versions, decisions };
    });
  }
}

/**
 * Applies a recorded decision in the club's transaction (app.apply_setting_decision)
 * and records what changed: the settings, the policy version, the members' notice.
 * Shared with the worker's clubs:apply_decisions job, which has its own copy.
 */
export async function applyDecisionInTx(tx: Tx, decisionId: string): Promise<string | null> {
  // A decision of the mileage rate alone (P2.5) is applied without a new policy version.
  const { rows } = await tx.execute<{ applied: boolean; policy_id: string | null }>(
    sql`SELECT applied, policy_id FROM app.apply_board_decision(${decisionId}, ${PRIVACY_POLICY_TEMPLATE_VERSION})`,
  );
  if (!rows[0]?.applied) return null;
  const policyId = rows[0].policy_id;
  const decision = (await repo.findDecision(tx, decisionId))!;
  await audit.record(tx, {
    action: "club.settings.updated",
    resourceType: "club",
    resourceId: decision.clubId,
    changedFields: Object.keys(decision.settings).map(
      (key) => CLUB_SETTINGS[key as BoardSettingKey].field,
    ),
  });
  if (!policyId) return null;
  await audit.record(tx, {
    action: "club.privacy_policy.published",
    resourceType: "club_privacy_policy",
    resourceId: policyId,
  });
  await outbox.publish(tx, "club.privacy_policy.published", {
    clubId: decision.clubId,
    policyId,
  });
  return policyId;
}
