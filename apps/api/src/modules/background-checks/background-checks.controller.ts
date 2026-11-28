// SPDX-License-Identifier: AGPL-3.0-only
// Background checks (P2.8): the club's overview and requirements, ticking off
// a shown certificate (a second factor), deleting a record, a request the
// club starts (Norway), and one's own status. People go through the
// PersonPresenter (ADR 0022): hidden people are left out and counted.

import { negotiateLocale } from "@clubadmin/i18n";
import {
  type BackgroundCheckOverview,
  type BackgroundCheckOverviewQuery,
  BackgroundCheckOverviewQuerySchema,
  BackgroundCheckOverviewSchema,
  type BackgroundCheckRecord,
  BackgroundCheckRecordCreatedSchema,
  BackgroundCheckRecordParamsSchema,
  BackgroundCheckRequestCreatedSchema,
  type BackgroundCheckRequirements,
  BackgroundCheckRequirementsSchema,
  ClubParamsSchema,
  type CreateBackgroundCheckRecordInput,
  CreateBackgroundCheckRecordSchema,
  type CreateBackgroundCheckRequestInput,
  CreateBackgroundCheckRequestSchema,
  type MyBackgroundChecks,
  MyBackgroundChecksQuerySchema,
  MyBackgroundChecksSchema,
  type PersonSummary,
  type PutBackgroundCheckRequirementsInput,
  PutBackgroundCheckRequirementsSchema,
  z,
} from "@clubadmin/shared";
import { Body, Controller, Param, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  CurrentAuthorization,
  PersonPresenter,
  type RequestAuthorization,
  resourceOf,
  tenantContext,
} from "../authorization/index.ts";
import { RequireMfa } from "../identity/principal.ts";
import { PeopleService } from "../people/index.ts";
import type { RecordRow } from "./background-checks.repository.ts";
import { BackgroundChecksService, EXPIRING_DAYS } from "./background-checks.service.ts";

const TAGS = ["background-checks"];
const localeOf = (request: FastifyRequest) => negotiateLocale(request.headers["accept-language"]);

@Controller()
export class BackgroundChecksController {
  private readonly checks: BackgroundChecksService;
  private readonly people: PeopleService;
  private readonly presenter: PersonPresenter;

  constructor(checks: BackgroundChecksService, people: PeopleService, presenter: PersonPresenter) {
    this.checks = checks;
    this.people = people;
    this.presenter = presenter;
  }

  private async persons(
    authz: RequestAuthorization,
    clubId: string,
    ids: readonly string[],
  ): Promise<Map<string, PersonSummary>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.people.summaries(tenantContext(authz, clubId), unique);
    return new Map((await this.presenter.present(authz, clubId, rows)).map((p) => [p.id, p]));
  }

  private async records(
    rows: readonly RecordRow[],
    shown: Map<string, PersonSummary>,
    locale: string,
  ): Promise<BackgroundCheckRecord[]> {
    return Promise.all(
      rows.map(async (r) => ({
        id: r.id,
        pluginId: r.pluginId,
        checkType: r.checkType,
        checkTypeName: await this.checks.typeName(r.pluginId, r.checkType, locale),
        issuingCountry: r.issuingCountry,
        issuedOn: r.issuedOn,
        verifiedOn: r.verifiedOn,
        verifiedBy: r.verifiedByPersonId ? (shown.get(r.verifiedByPersonId) ?? null) : null,
        method: r.method,
        expiresOn: r.validUntil,
        closedReason: r.closedReason,
      })),
    );
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/background-checks/overview",
    summary: "Who needs a background check: missing, expiring, valid, records to delete",
    tags: TAGS,
    access: { permission: "club.background_checks.read", resource: "club" },
    request: { params: ClubParamsSchema, query: BackgroundCheckOverviewQuerySchema },
    response: BackgroundCheckOverviewSchema,
  })
  async overview(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: BackgroundCheckOverviewQuery,
    @Req() request: FastifyRequest,
  ): Promise<BackgroundCheckOverview> {
    const { clubId } = resourceOf(authz, "club");
    const result = await this.checks.overview(tenantContext(authz, clubId));
    const filtered = result.entries.filter((e) => !query.status || e.status === query.status);
    const start = query.cursor ? filtered.findIndex((e) => e.personId > query.cursor!) : 0;
    const page = (start < 0 ? [] : filtered.slice(start)).slice(0, query.limit + 1);
    const more = page.length > query.limit;
    const items = page.slice(0, query.limit);
    const shown = await this.persons(authz, clubId, [
      ...items.map((e) => e.personId),
      ...items.flatMap((e) => e.records.flatMap((r) => r.verifiedByPersonId ?? [])),
    ]);
    const locale = localeOf(request);
    const out: BackgroundCheckOverview["items"] = [];
    for (const e of items) {
      const person = shown.get(e.personId);
      if (!person) continue;
      out.push({
        person,
        status: e.status,
        categories: e.categories,
        expiresOn: e.expiresOn,
        records: await this.records(e.records, shown, locale),
        request: e.request,
      });
    }
    return {
      active: result.active,
      expiringDays: EXPIRING_DAYS,
      items: out,
      hiddenCount: items.length - out.length,
      nextCursor: more ? (items.at(-1)?.personId ?? null) : null,
    };
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/background-checks/requirements",
    summary: "The plugin's requirements, the club's stricter additions, roles and duty types",
    tags: TAGS,
    access: { permission: "club.background_checks.manage", resource: "club" },
    request: { params: ClubParamsSchema },
    response: BackgroundCheckRequirementsSchema,
  })
  async requirements(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Req() request: FastifyRequest,
  ): Promise<BackgroundCheckRequirements> {
    const { clubId } = resourceOf(authz, "club");
    const locale = localeOf(request);
    const result = await this.checks.requirements(tenantContext(authz, clubId), locale);
    return {
      ...result,
      roles: result.roles.map((r) => ({
        id: r.id,
        scope: r.scope,
        name: r.names?.[locale] ?? r.names?.sv ?? r.names?.en ?? r.templateKey ?? "",
        templateKey: r.templateKey,
        category: r.category,
      })),
    };
  }

  @Endpoint({
    method: "PUT",
    path: "clubs/:clubId/background-checks/requirements",
    summary: "The club's stricter requirements and duty types' categories (never weaker)",
    tags: TAGS,
    access: { permission: "club.background_checks.manage", resource: "club" },
    request: { params: ClubParamsSchema, body: PutBackgroundCheckRequirementsSchema },
    response: z.null(),
    status: 204,
  })
  async putRequirements(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: PutBackgroundCheckRequirementsInput,
  ): Promise<null> {
    const { clubId } = resourceOf(authz, "club");
    await this.checks.putRequirements(tenantContext(authz, clubId), body);
    return null;
  }

  @RequireMfa()
  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/background-checks/records",
    summary: "Tick off a certificate a person shows (nothing is uploaded or kept)",
    tags: TAGS,
    access: { permission: "club.background_checks.verify", resource: "club" },
    request: { params: ClubParamsSchema, body: CreateBackgroundCheckRecordSchema },
    response: BackgroundCheckRecordCreatedSchema,
    status: 201,
  })
  async record(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: CreateBackgroundCheckRecordInput,
    @Req() request: FastifyRequest,
  ): Promise<{ id: string; expiresOn: string | null }> {
    const { clubId } = resourceOf(authz, "club");
    return this.checks.record(tenantContext(authz, clubId), body, localeOf(request));
  }

  @RequireMfa()
  @Endpoint({
    method: "DELETE",
    path: "clubs/:clubId/background-checks/records/:recordId",
    summary: "Delete a background-check record (audited)",
    tags: TAGS,
    access: { permission: "club.background_checks.manage", resource: "club" },
    request: { params: BackgroundCheckRecordParamsSchema },
    response: z.null(),
    status: 204,
  })
  async deleteRecord(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("recordId") recordId: string,
  ): Promise<null> {
    const { clubId } = resourceOf(authz, "club");
    await this.checks.deleteRecord(tenantContext(authz, clubId), recordId);
    return null;
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/background-checks/requests",
    summary: "Start a check the club requests (Norway: the confirmation of purpose)",
    tags: TAGS,
    access: { permission: "club.background_checks.manage", resource: "club" },
    request: { params: ClubParamsSchema, body: CreateBackgroundCheckRequestSchema },
    response: BackgroundCheckRequestCreatedSchema,
    status: 201,
  })
  async request(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: CreateBackgroundCheckRequestInput,
  ): Promise<{ id: string; status: string }> {
    const { clubId } = resourceOf(authz, "club");
    return this.checks.request(tenantContext(authz, clubId), body);
  }

  @Endpoint({
    method: "GET",
    path: "me/background-checks",
    summary: "My background-check status in a club and what is required of me",
    tags: TAGS,
    access: { authenticated: true },
    request: { query: MyBackgroundChecksQuerySchema },
    response: MyBackgroundChecksSchema,
  })
  async mine(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: { clubId: string },
    @Req() request: FastifyRequest,
  ): Promise<MyBackgroundChecks> {
    if (authz.actor.onBehalfOf) throw new DomainError("not_allowed");
    const locale = localeOf(request);
    const result = await this.checks.mine(tenantContext(authz, query.clubId), locale);
    const shown = await this.persons(
      authz,
      query.clubId,
      result.records.flatMap((r) => r.verifiedByPersonId ?? []),
    );
    return {
      clubId: result.clubId,
      active: result.active,
      status: result.status,
      required: result.required,
      expiresOn: result.expiresOn,
      records: await this.records(result.records, shown, locale),
      howTo: result.howTo,
    };
  }
}
