// SPDX-License-Identifier: AGPL-3.0-only
// Grant reports (P2.7 part B, ADR 0051): the schemes of the club's enabled
// grant plugins, a period's report with what counts and why (people through
// the PersonPresenter, hidden ones left out), locking it and exporting its
// files. Submitting through an integration waits for one (RF: issue #22).

import { negotiateLocale } from "@clubadmin/i18n";
import {
  ClubParamsSchema,
  type GrantExportInput,
  GrantExportSchema,
  type GrantFiles,
  GrantFilesSchema,
  type GrantReport,
  GrantReportParamsSchema,
  type GrantReportQuery,
  GrantReportQuerySchema,
  GrantReportSchema,
  type GrantSchemeList,
  GrantSchemeListSchema,
  type PersonSummary,
  z,
} from "@clubadmin/shared";
import { Body, Controller, Param, Query, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";

import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  CurrentAuthorization,
  PersonPresenter,
  type RequestAuthorization,
  tenantContext,
} from "../authorization/index.ts";
import { PeopleService } from "../people/index.ts";
import type { ReportRow } from "./grants.repository.ts";
import { GrantsService, type StoredEvaluation, textsOf } from "./grants.service.ts";

const TAGS = ["grants"];

@Controller()
export class GrantsController {
  private readonly grants: GrantsService;
  private readonly people: PeopleService;
  private readonly presenter: PersonPresenter;

  constructor(grants: GrantsService, people: PeopleService, presenter: PersonPresenter) {
    this.grants = grants;
    this.people = people;
    this.presenter = presenter;
  }

  private async persons(
    authz: RequestAuthorization,
    clubId: string,
    ids: readonly (string | null)[],
  ): Promise<Map<string, PersonSummary>> {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (unique.length === 0) return new Map();
    const rows = await this.people.summaries(tenantContext(authz, clubId), unique);
    return new Map((await this.presenter.present(authz, clubId, rows)).map((p) => [p.id, p]));
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/grants/schemes",
    summary: "The schemes of the club's enabled grant plugins, with periods and deadlines",
    tags: TAGS,
    access: { permission: "club.grants.read", resource: "club" },
    request: { params: ClubParamsSchema },
    response: GrantSchemeListSchema,
  })
  schemes(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string },
    @Req() request: FastifyRequest,
  ): Promise<GrantSchemeList> {
    const locale = negotiateLocale(request.headers["accept-language"]);
    return this.grants.schemes(
      tenantContext(authz, params.clubId),
      locale,
      new Date().getUTCFullYear(),
    );
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/grants/report",
    summary: "A period's report: evaluated again while a draft, as locked otherwise",
    tags: TAGS,
    access: { permission: "club.grants.read", resource: "club" },
    request: { params: ClubParamsSchema, query: GrantReportQuerySchema },
    response: GrantReportSchema,
  })
  async report(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string },
    @Query() query: GrantReportQuery,
    @Req() request: FastifyRequest,
  ): Promise<GrantReport> {
    const locale = negotiateLocale(request.headers["accept-language"]);
    const { row, stored, plugin } = await this.grants.report(
      tenantContext(authz, params.clubId),
      query,
    );
    return this.toReport(authz, params.clubId, row, stored, textsOf(plugin, locale));
  }

  private async toReport(
    authz: RequestAuthorization,
    clubId: string,
    row: ReportRow,
    stored: StoredEvaluation,
    texts: Record<string, string>,
  ): Promise<GrantReport> {
    const result = stored.evaluation ?? stored.snapshot;
    const peopleRows =
      stored.evaluation?.people ??
      stored.snapshot?.people.map((p) => ({
        personId: p.personId,
        counted: p.codes.includes("lam.counted") ? 1 : 0,
        codes: p.codes,
      })) ??
      [];
    const persons = await this.persons(authz, clubId, [
      row.lockedByPersonId,
      ...peopleRows.map((p) => p.personId),
      ...(result?.missing ?? []).map((m) => m.personId),
    ]);
    const sessions = new Map(stored.sessions.map((s) => [s.id, s]));
    return {
      id: row.id,
      pluginId: row.pluginId,
      scheme: row.schemeKey,
      period: stored.period,
      status: row.status as GrantReport["status"],
      evaluatedAt: row.evaluatedAt?.toISOString() ?? null,
      lockedAt: row.lockedAt?.toISOString() ?? null,
      lockedBy: row.lockedByPersonId ? (persons.get(row.lockedByPersonId) ?? null) : null,
      attendanceChangedAt: row.attendanceChangedAt?.toISOString() ?? null,
      sessions: (stored.evaluation?.sessions ?? []).map((s) => ({
        sessionId: s.sessionId,
        title: sessions.get(s.sessionId)?.title ?? "",
        date: sessions.get(s.sessionId)?.date ?? stored.period.from,
        counts: s.counts,
        codes: [...s.codes],
        counted: s.countedPersonIds.length,
      })),
      people: peopleRows.flatMap((p) => {
        const person = persons.get(p.personId);
        return person ? [{ person, counted: p.counted, codes: [...p.codes] }] : [];
      }),
      totals: (result?.totals ?? []).map((t) => ({
        measure: t.measure,
        dimensions: { ...t.dimensions },
        value: t.value,
      })),
      missing: (result?.missing ?? []).flatMap((m) => {
        const person = persons.get(m.personId);
        return person ? [{ person, field: m.field }] : [];
      }),
      texts,
    };
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/grants/reports/:reportId/lock",
    summary: "Lock a period's report (its evaluation is kept as it is)",
    tags: TAGS,
    access: { permission: "club.grants.report", resource: "club" },
    request: { params: GrantReportParamsSchema },
    response: z.null(),
    status: 204,
  })
  async lock(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; reportId: string },
  ): Promise<null> {
    await this.grants.lock(tenantContext(authz, params.clubId), params.reportId);
    return null;
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/grants/reports/:reportId/export",
    summary: "A locked report's files (CSV, PDF, …) from its plugin",
    tags: TAGS,
    access: { permission: "club.grants.report", resource: "club" },
    request: { params: GrantReportParamsSchema, body: GrantExportSchema },
    response: GrantFilesSchema,
    status: 200,
  })
  async export(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; reportId: string },
    @Body() body: GrantExportInput,
  ): Promise<GrantFiles> {
    return {
      files: await this.grants.export(
        tenantContext(authz, params.clubId),
        params.reportId,
        body.format,
      ),
    };
  }
}
