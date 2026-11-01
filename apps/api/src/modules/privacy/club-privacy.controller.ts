// SPDX-License-Identifier: AGPL-3.0-only
// The club's privacy page, policy, board decisions and consent texts (P1.8a).

import {
  BOARD_SETTING_KEYS,
  CLUB_SETTING_KEYS,
  CLUB_SETTINGS,
  ClubParamsSchema,
  type ClubPrivacy,
  ClubPrivacySchema,
  type ClubSettingDefinition,
  type ConsentPurpose,
  ConsentTextsQuerySchema,
  ConsentTextVersionsSchema,
  DecisionsPageSchema,
  type PageQuery,
  PageQuerySchema,
  type PrivacyPolicy,
  PrivacyPolicyQuerySchema,
  PrivacyPolicySchema,
  type PublishConsentTextInput,
  PublishConsentTextSchema,
  type RecordDecisionInput,
  RecordDecisionSchema,
  RETENTION_RULES,
  type SettingDecision,
  SettingDecisionSchema,
  type z,
} from "@clubadmin/shared";
import { Body, Controller, Inject, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";

import { API_CONFIG, type ApiConfig } from "../../config.ts";
import { Endpoint } from "../../platform/http/endpoint.ts";
import { ProblemError } from "../../platform/http/problem-error.ts";
import {
  CurrentAuthorization,
  PersonPresenter,
  type RequestAuthorization,
  resourceOf,
  tenantContext,
} from "../authorization/index.ts";
import { RecentAuth } from "../identity/index.ts";
import { PeopleService } from "../people/index.ts";
import { ClubPrivacyService, type Decision, packLimits } from "./club-privacy.service.ts";
import { localeOfRequest } from "./consents.controller.ts";
import { ConsentsService } from "./consents.service.ts";
import { renderConsentText, renderPolicy } from "./privacy-texts.ts";

const ref = (d: Decision) => ({
  id: d.id,
  body: d.body,
  decidedOn: d.decidedOn,
  reference: d.reference,
  effectiveFrom: d.effectiveFrom,
});

@Controller("clubs")
export class ClubPrivacyController {
  private readonly privacy: ClubPrivacyService;
  private readonly consents: ConsentsService;
  private readonly people: PeopleService;
  private readonly presenter: PersonPresenter;
  private readonly config: ApiConfig;

  constructor(
    privacy: ClubPrivacyService,
    consents: ConsentsService,
    people: PeopleService,
    presenter: PersonPresenter,
    @Inject(API_CONFIG) config: ApiConfig,
  ) {
    this.privacy = privacy;
    this.consents = consents;
    this.people = people;
    this.presenter = presenter;
    this.config = config;
  }

  @Endpoint({
    method: "GET",
    path: ":clubId/privacy",
    summary:
      "The club's privacy rules: consents asked, texts, settings and the decisions behind them",
    tags: ["privacy"],
    access: { permission: "club.read", resource: "club" },
    request: { params: ClubParamsSchema },
    response: ClubPrivacySchema,
  })
  async privacyPage(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Req() request: FastifyRequest,
  ): Promise<ClubPrivacy> {
    const { clubId } = resourceOf(authz, "club");
    const locale = localeOfRequest(request);
    const { club, texts, decisions, pending } = await this.privacy.overview(
      tenantContext(authz, clubId),
    );
    const byPurpose = new Map(texts.map((t) => [t.purpose, t]));
    const values = club as unknown as Record<string, unknown>;
    return {
      clubId,
      privacyContactEmail: club.privacyContactEmail,
      consentPurposes: club.consentPurposes,
      texts: club.consentPurposes.map((purpose) => ({
        purpose,
        ...renderConsentText(locale, purpose, byPurpose.get(purpose), club),
      })),
      settings: CLUB_SETTING_KEYS.map((key) => {
        const definition: ClubSettingDefinition = CLUB_SETTINGS[key];
        const decision = decisions.get(key);
        const limits =
          definition.type === "integer"
            ? (() => {
                const pack = packLimits(club.country, key);
                return {
                  min: Math.max(definition.min, pack.min ?? definition.min),
                  max: Math.min(definition.max, pack.max ?? definition.max),
                  unit: definition.unit,
                };
              })()
            : {};
        return {
          key,
          value: values[definition.field] ?? null,
          default: definition.default,
          decidedBy: definition.decidedBy,
          ...limits,
          decision: decision ? ref(decision) : null,
        };
      }),
      retention: RETENTION_RULES.map((rule) => ({
        key: rule.key,
        period:
          rule.period !== "until_erased" && rule.setting
            ? {
                value: Number(values[CLUB_SETTINGS[rule.setting].field] ?? rule.period.value),
                unit: rule.period.unit,
              }
            : rule.period !== "until_erased" && rule.installationSetting
              ? {
                  value: this.installationMonths(rule.installationSetting, rule.period.value),
                  unit: rule.period.unit,
                }
              : rule.period,
        setting: rule.setting ?? null,
        installationSetting: rule.installationSetting ?? null,
        status: rule.status,
      })),
      pending: pending.map(ref),
    };
  }

  private installationMonths(name: string, fallback: number): number {
    const value = (this.config as unknown as Record<string, unknown>)[name];
    return typeof value === "number" ? value : fallback;
  }

  @Endpoint({
    method: "GET",
    path: ":clubId/privacy-policy",
    summary: "The club's privacy policy in my language (current, or a given version)",
    tags: ["privacy"],
    access: { permission: "club.read", resource: "club" },
    request: { params: ClubParamsSchema, query: PrivacyPolicyQuerySchema },
    response: PrivacyPolicySchema,
  })
  async policy(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: z.infer<typeof PrivacyPolicyQuerySchema>,
    @Req() request: FastifyRequest,
  ): Promise<PrivacyPolicy> {
    const { clubId } = resourceOf(authz, "club");
    const locale = localeOfRequest(request);
    const { club, versions, decisions } = await this.privacy.policies(tenantContext(authz, clubId));
    const shown = query.version ? versions.find((v) => v.version === query.version) : versions[0];
    if (!shown) throw new ProblemError("not-found");
    const s = shown.settings;
    // Which decision each board value of this version rests on: the latest
    // decision up to this version that contains it.
    const upTo = versions.filter((v) => v.version <= shown.version);
    const decisionOf = (key: string) => {
      for (const v of upTo) {
        const d = v.decisionId ? decisions.get(v.decisionId) : undefined;
        if (d && key in d.settings) return ref(d);
      }
      return null;
    };
    return {
      clubId,
      version: shown.version,
      effectiveFrom: shown.effectiveFrom,
      templateVersion: shown.templateVersion,
      sections: renderPolicy(locale, shown.templateVersion, {
        club: club.name,
        organizationNumber: club.organizationNumber ?? "",
        contact: (s.privacy_contact_email as string | null) ?? club.email ?? "",
        formerMemberMonths: Number(s.former_member_retention_months),
        attendanceMonths: Number(s.attendance_retention_months),
        purposes: (s.consent_purposes as ConsentPurpose[] | undefined) ?? [],
        auditMonths: this.config.AUDIT_RETENTION_MONTHS,
        historyMonths: this.config.HISTORY_RETENTION_MONTHS,
        orphanMonths: this.config.ORPHAN_RETENTION_MONTHS,
      }),
      decisions: BOARD_SETTING_KEYS.map((key) => ({ key, decision: decisionOf(key) })),
      versions: versions.map((v) => {
        const d = v.decisionId ? decisions.get(v.decisionId) : undefined;
        return { version: v.version, effectiveFrom: v.effectiveFrom, decision: d ? ref(d) : null };
      }),
    };
  }

  @Endpoint({
    method: "POST",
    path: ":clubId/setting-decisions",
    summary: "Record a decision of the board (or a meeting) on the club's privacy settings",
    tags: ["privacy"],
    access: { permission: "club.settings.update", resource: "club" },
    request: { params: ClubParamsSchema, body: RecordDecisionSchema },
    response: SettingDecisionSchema,
    status: 201,
  })
  @RecentAuth(15)
  async recordDecision(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: RecordDecisionInput,
  ): Promise<SettingDecision> {
    const { clubId } = resourceOf(authz, "club");
    const decision = await this.privacy.recordDecision(tenantContext(authz, clubId), body);
    return (await this.decisionsOut(authz, clubId, [decision]))[0]!;
  }

  @Endpoint({
    method: "GET",
    path: ":clubId/setting-decisions",
    summary: "The club's recorded decisions on its settings, newest first",
    tags: ["privacy"],
    access: { permission: "club.read", resource: "club" },
    request: { params: ClubParamsSchema, query: PageQuerySchema },
    response: DecisionsPageSchema,
  })
  async decisions(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: PageQuery,
  ): Promise<z.infer<typeof DecisionsPageSchema>> {
    const { clubId } = resourceOf(authz, "club");
    const page = await this.privacy.decisions(tenantContext(authz, clubId), query);
    return {
      items: await this.decisionsOut(authz, clubId, page.items),
      nextCursor: page.nextCursor,
    };
  }

  private async decisionsOut(
    authz: RequestAuthorization,
    clubId: string,
    decisions: readonly Decision[],
  ): Promise<SettingDecision[]> {
    const shown = new Map(
      (
        await this.presenter.present(
          authz,
          clubId,
          await this.people.summaries(tenantContext(authz, clubId), [
            ...new Set(decisions.map((d) => d.recordedByPersonId)),
          ]),
        )
      ).map((s) => [s.id, s]),
    );
    return decisions.map((d) => ({
      ...ref(d),
      settings: d.settings,
      applied: d.appliedAt !== null,
      recordedAt: d.recordedAt.toISOString(),
      recordedBy: shown.get(d.recordedByPersonId) ?? null,
    }));
  }

  @Endpoint({
    method: "GET",
    path: ":clubId/consent-texts",
    summary: "The club's published texts of a consent purpose, and the platform default",
    tags: ["privacy"],
    access: { permission: "club.read", resource: "club" },
    request: { params: ClubParamsSchema, query: ConsentTextsQuerySchema },
    response: ConsentTextVersionsSchema,
  })
  async textVersions(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: z.infer<typeof ConsentTextsQuerySchema>,
    @Req() request: FastifyRequest,
  ): Promise<z.infer<typeof ConsentTextVersionsSchema>> {
    const { clubId } = resourceOf(authz, "club");
    const context = tenantContext(authz, clubId);
    const versions = await this.consents.textVersions(context, query.purpose);
    const { club } = await this.privacy.overview(context);
    const shown = new Map(
      (
        await this.presenter.present(
          authz,
          clubId,
          await this.people.summaries(context, [
            ...new Set(versions.map((v) => v.publishedByPersonId)),
          ]),
        )
      ).map((s) => [s.id, s]),
    );
    const fallback = renderConsentText(localeOfRequest(request), query.purpose, undefined, club);
    return {
      purpose: query.purpose,
      current: versions[0] ? `club:${versions[0].version}` : fallback.textVersion,
      default: fallback,
      versions: versions.map((v) => ({
        textVersion: `club:${v.version}`,
        texts: v.texts,
        publishedAt: v.publishedAt.toISOString(),
        publishedBy: shown.get(v.publishedByPersonId) ?? null,
      })),
    };
  }

  @Endpoint({
    method: "POST",
    path: ":clubId/consent-texts",
    summary: "Publish the club's next version of a consent text",
    tags: ["privacy"],
    access: { permission: "club.settings.update", resource: "club" },
    request: { params: ClubParamsSchema, body: PublishConsentTextSchema },
    response: ConsentTextVersionsSchema,
    status: 201,
  })
  async publishText(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: PublishConsentTextInput,
    @Req() request: FastifyRequest,
  ): Promise<z.infer<typeof ConsentTextVersionsSchema>> {
    const { clubId } = resourceOf(authz, "club");
    await this.consents.publishText(tenantContext(authz, clubId), body);
    return this.textVersions(authz, { purpose: body.purpose }, request);
  }
}
