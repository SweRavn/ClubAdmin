// SPDX-License-Identifier: AGPL-3.0-only
// The administrators API (P1.15 A3, ADR 0046): who administers the club and
// who counts, the club's state and grace period, and the two-person rule for
// suspending an administrator. People through PersonPresenter (ADR 0022).

import {
  AdministratorParamsSchema,
  type AdministratorsOverview,
  AdministratorsOverviewSchema,
  type AdministratorSuspension,
  AdministratorSuspensionSchema,
  ClubParamsSchema,
  type GraceExtension,
  GraceExtensionSchema,
  type PersonSummary,
  type StartSuspensionInput,
  StartSuspensionSchema,
  SuspensionParamsSchema,
  type SuspensionResult,
  SuspensionResultSchema,
  type SuspensionReview,
  SuspensionReviewSchema,
} from "@clubadmin/shared";
import { Body, Controller, Param } from "@nestjs/common";

import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  CurrentAuthorization,
  PersonPresenter,
  type RequestAuthorization,
  resourceOf,
  tenantContext,
} from "../authorization/index.ts";
import { RecentAuth, SessionsService } from "../identity/index.ts";
import { PeopleService } from "../people/index.ts";
import { AdministratorsService, type SuspensionRow } from "./administrators.service.ts";

/** Minutes since the last login for starting and confirming a suspension. */
const RECENT_LOGIN_MINUTES = 15;

@Controller()
export class AdministratorsController {
  private readonly administrators: AdministratorsService;
  private readonly people: PeopleService;
  private readonly presenter: PersonPresenter;
  private readonly sessions: SessionsService;

  constructor(
    administrators: AdministratorsService,
    people: PeopleService,
    presenter: PersonPresenter,
    sessions: SessionsService,
  ) {
    this.administrators = administrators;
    this.people = people;
    this.presenter = presenter;
    this.sessions = sessions;
  }

  /** The people as the caller may see them, by ID (hidden people are left out). */
  private async shown(
    authz: RequestAuthorization,
    clubId: string,
    ids: Iterable<string>,
  ): Promise<Map<string, PersonSummary>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const context = tenantContext(authz, clubId);
    const presented = await this.presenter.present(
      authz,
      clubId,
      await this.people.summaries(context, unique),
    );
    return new Map(presented.map((p) => [p.id, p]));
  }

  private toSuspension(
    row: SuspensionRow,
    shown: Map<string, PersonSummary>,
  ): AdministratorSuspension | null {
    const target = shown.get(row.targetPersonId);
    const requestedBy = shown.get(row.requestedByPersonId);
    if (!target || !requestedBy) return null;
    return {
      id: row.id,
      target,
      requestedBy,
      confirmedBy: row.confirmedByPersonId ? (shown.get(row.confirmedByPersonId) ?? null) : null,
      reason: row.reason,
      note: row.note,
      demote: row.demote,
      status: row.status,
      expiresAt: row.expiresAt.toISOString(),
      decidedAt: row.decidedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async presentSuspension(
    authz: RequestAuthorization,
    clubId: string,
    row: SuspensionRow,
  ): Promise<AdministratorSuspension> {
    const shown = await this.shown(authz, clubId, [
      row.targetPersonId,
      row.requestedByPersonId,
      ...(row.confirmedByPersonId ? [row.confirmedByPersonId] : []),
    ]);
    const suspension = this.toSuspension(row, shown);
    if (!suspension) throw new Error("an administrator suspension's people must be visible");
    return suspension;
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/administrators",
    summary: "The club's administrators, who counts and why, its state and open suspensions",
    tags: ["roles"],
    access: { permission: "club.roles.read", resource: "club" },
    request: { params: ClubParamsSchema },
    response: AdministratorsOverviewSchema,
  })
  async overview(
    @CurrentAuthorization() authz: RequestAuthorization,
  ): Promise<AdministratorsOverview> {
    const { clubId } = resourceOf(authz, "club");
    const facts = await this.administrators.overview(tenantContext(authz, clubId));
    const shown = await this.shown(authz, clubId, [
      ...facts.administrators.map((a) => a.personId),
      ...facts.suspensions.flatMap((s) => [s.targetPersonId, s.requestedByPersonId]),
    ]);
    return {
      items: facts.administrators.flatMap((a) => {
        const person = shown.get(a.personId);
        return person ? [{ person, counts: a.counts, reason: a.reason, roleIds: a.roleIds }] : [];
      }),
      count: facts.count,
      state: facts.state,
      graceUntil: facts.graceUntil?.toISOString() ?? null,
      graceExtended: facts.graceExtended,
      suspensions: facts.suspensions.flatMap((s) => {
        const suspension = this.toSuspension(s, shown);
        return suspension ? [suspension] : [];
      }),
    };
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/administrators/:personId/suspensions",
    summary: "Start suspending an administrator (another administrator or the chair confirms)",
    tags: ["roles"],
    access: { permission: "club.roles.manage", resource: "club" },
    request: { params: AdministratorParamsSchema, body: StartSuspensionSchema },
    response: AdministratorSuspensionSchema,
    status: 201,
  })
  @RecentAuth(RECENT_LOGIN_MINUTES)
  async start(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("personId") personId: string,
    @Body() body: StartSuspensionInput,
  ): Promise<AdministratorSuspension> {
    const { clubId } = resourceOf(authz, "club");
    const row = await this.administrators.start(tenantContext(authz, clubId), personId, body);
    return this.presentSuspension(authz, clubId, row);
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/administrator-suspensions/:suspensionId/confirm",
    summary: "Confirm a suspension: the administrator's roles end at once (two-person rule)",
    tags: ["roles"],
    access: {
      permission: "club.administrators.confirm_suspension",
      resource: "administrator_suspension",
    },
    request: { params: SuspensionParamsSchema },
    response: SuspensionResultSchema,
  })
  @RecentAuth(RECENT_LOGIN_MINUTES)
  async confirm(@CurrentAuthorization() authz: RequestAuthorization): Promise<SuspensionResult> {
    const { clubId, suspensionId } = resourceOf(authz, "administrator_suspension");
    const result = await this.administrators.confirm(tenantContext(authz, clubId), suspensionId);
    // A compromised login loses every session, here and at the identity provider.
    if (result.suspension.reason === "compromised") {
      await this.sessions.revokeEverywhere(result.suspension.targetPersonId, result.idpSubject);
    }
    return {
      suspension: await this.presentSuspension(authz, clubId, result.suspension),
      endedRoles: result.endedRoles,
      endedGroupRoles: result.endedGroupRoles,
    };
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/administrator-suspensions/:suspensionId/cancel",
    summary: "Withdraw a suspension request (its initiator only)",
    tags: ["roles"],
    access: { permission: "club.roles.manage", resource: "club" },
    request: { params: SuspensionParamsSchema },
    response: AdministratorSuspensionSchema,
  })
  async cancel(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("suspensionId") suspensionId: string,
  ): Promise<AdministratorSuspension> {
    const { clubId } = resourceOf(authz, "club");
    const row = await this.administrators.cancel(tenantContext(authz, clubId), suspensionId);
    return this.presentSuspension(authz, clubId, row);
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/administrator-suspensions/:suspensionId/review",
    summary: "The target's role and permission changes of the last 14 days, to review",
    tags: ["roles"],
    access: { permission: "club.roles.manage", resource: "club" },
    request: { params: SuspensionParamsSchema },
    response: SuspensionReviewSchema,
  })
  async review(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("suspensionId") suspensionId: string,
  ): Promise<SuspensionReview> {
    const { clubId } = resourceOf(authz, "club");
    const rows = await this.administrators.review(tenantContext(authz, clubId), suspensionId);
    return {
      items: rows.map((r) => ({
        action: r.action,
        resourceType: r.resourceType,
        resourceId: r.resourceId,
        occurredAt: r.occurredAt.toISOString(),
      })),
    };
  }

  @Endpoint({
    method: "POST",
    path: "ops/clubs/:clubId/administrators/grace-extension",
    summary: "Operator: give a club with fewer than two administrators more time (once)",
    tags: ["ops"],
    access: { permission: "club.administrators.extend_grace", resource: "club" },
    request: { params: ClubParamsSchema },
    response: GraceExtensionSchema,
    clubAccess: "exempt",
  })
  async extendGrace(@CurrentAuthorization() authz: RequestAuthorization): Promise<GraceExtension> {
    const { clubId } = resourceOf(authz, "club");
    const graceUntil = await this.administrators.extendGrace(tenantContext(authz, clubId));
    return { graceUntil: graceUntil.toISOString() };
  }
}
