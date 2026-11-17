// SPDX-License-Identifier: AGPL-3.0-only
// Expense claims and attestation (P2.5 part B, ADR 0048): the caller's
// claimable drives and claims ("Mina utlägg"), the attesters' queue, the
// decision and the CSV export of approved claims. The `finance` feature.
// Claimants, attesters and the export's names go through the
// PersonPresenter (ADR 0022).

import {
  type ClaimableDrives,
  ClaimableDrivesSchema,
  ClubParamsSchema,
  type CreateMileageClaimInput,
  CreateMileageClaimSchema,
  type DecideExpenseClaimInput,
  DecideExpenseClaimSchema,
  type ExpenseClaim,
  type ExpenseClaimPage,
  ExpenseClaimPageSchema,
  ExpenseClaimParamsSchema,
  type ExpenseClaimQuery,
  ExpenseClaimQuerySchema,
  ExpenseClaimSchema,
  type ExpenseExportQuery,
  ExpenseExportQuerySchema,
  type MyExpenseClaimQuery,
  MyExpenseClaimQuerySchema,
  type PersonSummary,
  z,
} from "@clubadmin/shared";
import { Body, Controller, Param, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";

import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  CurrentAuthorization,
  PersonPresenter,
  type RequestAuthorization,
  tenantContext,
} from "../authorization/index.ts";
import { RequiresEntitlement } from "../entitlements/index.ts";
import { PeopleService } from "../people/index.ts";
import { type AttestScope, type ClaimRow, ExpensesService } from "./expenses.service.ts";

const TAGS = ["expenses"];

/** A CSV cell: quoted when needed; text never read as a formula (amounts stay numbers). */
function csvCell(value: string): string {
  const numeric = /^-?\d+(\.\d+)?$/.test(value);
  const safe = !numeric && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
const amount = (minor: number) => (minor / 100).toFixed(2);

const ClaimCreatedSchema = z.object({ id: z.uuid() }).openapi("ExpenseClaimCreated");
const ClaimableQuerySchema = z.object({ clubId: z.uuid() });

@Controller()
export class ExpensesController {
  private readonly expenses: ExpensesService;
  private readonly people: PeopleService;
  private readonly presenter: PersonPresenter;

  constructor(expenses: ExpensesService, people: PeopleService, presenter: PersonPresenter) {
    this.expenses = expenses;
    this.people = people;
    this.presenter = presenter;
  }

  /** Whom the caller may attest for in the club: every group, or these. */
  private scope(authz: RequestAuthorization, clubId: string): AttestScope {
    if (!authz.actor.onBehalfOf && authz.actor.holds("club.expenses.attest", clubId)) {
      return { club: true };
    }
    if (authz.actor.onBehalfOf) return { club: false, groupIds: [], ownedGroupIds: [] };
    return {
      club: false,
      groupIds: authz.actor.groupsHolding("group.expenses.attest", clubId),
      // Owners attest their groups and the groups under them.
      ownedGroupIds: authz.actor.relationships.ownedGroups
        .filter((o) => o.clubId === clubId)
        .map((o) => o.groupId),
    };
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

  private toClaim(
    c: ClaimRow,
    persons: Map<string, PersonSummary>,
    canDecide: boolean,
  ): ExpenseClaim {
    return {
      id: c.id,
      clubId: c.clubId,
      ...(c.clubName === undefined ? {} : { clubName: c.clubName }),
      kind: c.kind,
      claimant: persons.get(c.claimantPersonId) ?? null,
      groupId: c.groupId,
      groupName: c.groupName,
      activityId: c.activityId,
      amountMinor: c.amountMinor,
      currency: c.currency,
      status: c.status,
      routedTo: (c.routedToPersonId && persons.get(c.routedToPersonId)) || null,
      decidedBy: (c.decidedByPersonId && persons.get(c.decidedByPersonId)) || null,
      decidedAt: c.decidedAt?.toISOString() ?? null,
      reason: c.reason,
      createdAt: c.createdAt.toISOString(),
      lines: c.lines,
      canDecide,
    };
  }

  // --- The claimant's own -----------------------------------------------------------

  @Endpoint({
    method: "GET",
    path: "me/expense-claims/claimable",
    summary: "My drives in a club not yet claimed, with the club's mileage rate",
    tags: TAGS,
    access: { authenticated: true },
    request: { query: ClaimableQuerySchema },
    response: ClaimableDrivesSchema,
  })
  async claimable(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: { clubId: string },
  ): Promise<ClaimableDrives> {
    const result = await this.expenses.claimable({ ...authz.context, clubId: query.clubId });
    return {
      clubId: query.clubId,
      currency: result.currency,
      mileageRate: result.mileageRate,
      drives: result.drives.map((d) => ({
        offerId: d.offerId,
        activityId: d.activityId,
        activityTitle: d.activityTitle,
        startsAt: d.startsAt.toISOString(),
        groupIds: d.groupIds,
        direction: d.direction,
        distanceKm: d.distanceKm,
      })),
    };
  }

  @Endpoint({
    method: "POST",
    path: "me/expense-claims",
    summary: "Turn my drives into a mileage claim (the finance feature)",
    tags: TAGS,
    access: { authenticated: true },
    request: { body: CreateMileageClaimSchema },
    response: ClaimCreatedSchema,
    status: 201,
  })
  create(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: CreateMileageClaimInput,
  ): Promise<{ id: string }> {
    return this.expenses.createMileageClaim(authz.context, body);
  }

  @Endpoint({
    method: "GET",
    path: "me/expense-claims",
    summary: "Mina utlägg: my claims across my clubs, newest first",
    tags: TAGS,
    access: { authenticated: true },
    request: { query: MyExpenseClaimQuerySchema },
    response: ExpenseClaimPageSchema,
  })
  async mine(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: MyExpenseClaimQuery,
  ): Promise<ExpenseClaimPage> {
    const page = await this.expenses.myClaims(authz.context, query);
    const me = authz.actor.personId;
    const byClub = new Map<string, string[]>();
    for (const c of page.items) {
      const ids = byClub.get(c.clubId) ?? [];
      ids.push(me, ...[c.decidedByPersonId, c.routedToPersonId].filter((id): id is string => !!id));
      byClub.set(c.clubId, ids);
    }
    const persons = new Map<string, Map<string, PersonSummary>>();
    for (const [clubId, ids] of byClub) persons.set(clubId, await this.persons(authz, clubId, ids));
    return {
      items: page.items.map((c) =>
        this.toClaim(
          { ...c, claimantPersonId: me },
          persons.get(c.clubId) ?? new Map<string, PersonSummary>(),
          false,
        ),
      ),
      nextCursor: page.nextCursor,
    };
  }

  // --- The attesters' ----------------------------------------------------------------

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/expense-claims",
    summary: "Claims to attest: the club's for its attesters, a group's for the group's",
    tags: TAGS,
    access: { permission: "club.expenses.read", resource: "club" },
    request: { params: ClubParamsSchema, query: ExpenseClaimQuerySchema },
    response: ExpenseClaimPageSchema,
  })
  @RequiresEntitlement("finance")
  async queue(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string },
    @Query() query: ExpenseClaimQuery,
  ): Promise<ExpenseClaimPage> {
    const page = await this.expenses.queue(
      tenantContext(authz, params.clubId),
      this.scope(authz, params.clubId),
      query,
    );
    const persons = await this.persons(
      authz,
      params.clubId,
      page.items.flatMap((c) => [c.claimantPersonId, c.routedToPersonId, c.decidedByPersonId]),
    );
    const me = authz.actor.personId;
    return {
      items: page.items.map((c) =>
        this.toClaim(c, persons, c.status === "submitted" && c.claimantPersonId !== me),
      ),
      nextCursor: page.nextCursor,
    };
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/expense-claims/:claimId/decision",
    summary: "Approve or reject a claim (with a reason); never one's own",
    tags: TAGS,
    access: { permission: "club.expenses.read", resource: "club" },
    request: { params: ExpenseClaimParamsSchema, body: DecideExpenseClaimSchema },
    response: ExpenseClaimSchema,
    status: 200,
  })
  @RequiresEntitlement("finance")
  async decide(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string; claimId: string },
    @Body() body: DecideExpenseClaimInput,
  ): Promise<ExpenseClaim> {
    const claim = await this.expenses.decide(
      tenantContext(authz, params.clubId),
      this.scope(authz, params.clubId),
      params.claimId,
      body,
    );
    const persons = await this.persons(authz, params.clubId, [
      claim.claimantPersonId,
      claim.routedToPersonId,
      claim.decidedByPersonId,
    ]);
    return this.toClaim(claim, persons, false);
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/expense-claims/export",
    summary: "Approved claims decided in a period, as CSV for payment (marked exported)",
    tags: TAGS,
    access: { permission: "club.expenses.attest", resource: "club" },
    request: { params: ClubParamsSchema, query: ExpenseExportQuerySchema },
    response: z.string(),
    responseType: "text/csv",
  })
  @RequiresEntitlement("finance")
  async export(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { clubId: string },
    @Query() query: ExpenseExportQuery,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<string> {
    const result = await this.expenses.export(tenantContext(authz, params.clubId), query);
    const persons = await this.persons(
      authz,
      params.clubId,
      result.rows.map((r) => r.claimantPersonId),
    );
    const day = new Intl.DateTimeFormat("sv-SE", { timeZone: result.timeZone, dateStyle: "short" });
    const rows: string[][] = [
      ["claim", "decided", "claimant", "group", "kind", "km", "currency", "amount"],
      ...result.rows.map((r) => [
        r.id,
        day.format(r.decidedAt),
        persons.get(r.claimantPersonId)?.displayName ?? "",
        r.groupName,
        r.kind,
        r.quantity.toFixed(1),
        r.currency,
        amount(r.amountMinor),
      ]),
    ];
    void reply.header("content-type", "text/csv; charset=utf-8");
    void reply.header(
      "content-disposition",
      `attachment; filename="expense-claims-${query.from}-${query.to}.csv"`,
    );
    void reply.header("cache-control", "no-store");
    return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
  }
}
