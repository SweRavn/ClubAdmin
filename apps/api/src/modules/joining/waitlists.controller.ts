// SPDX-License-Identifier: AGPL-3.0-only
// Waiting lists of groups (P1.10b, ADR 0043): applying and answering offers
// (login only; the person must be the caller or a ward they act for, else
// 404), the owners' list and decisions (group.waitlist.manage) and the club
// managers' view (club.waitlists.read). People leave only through the
// PersonPresenter; owners see protected applicants of their group with the
// icon (ADR 0022 amendment), nobody else does.

import {
  type AdmitWaitlistEntryInput,
  AdmitWaitlistEntrySchema,
  type ApplyWaitlistInput,
  ApplyWaitlistSchema,
  ClubParamsSchema,
  type ClubWaitlists,
  type ClubWaitlistsQuery,
  ClubWaitlistsQuerySchema,
  ClubWaitlistsSchema,
  GroupParamsSchema,
  type GroupWaitlist,
  type GroupWaitlistQuery,
  GroupWaitlistQuerySchema,
  GroupWaitlistSchema,
  MyWaitlistEntryParamsSchema,
  type OfferWaitlistEntryInput,
  OfferWaitlistEntrySchema,
  OkSchema,
  type OpenGroups,
  OpenGroupsSchema,
  type PersonSummary,
  type RemoveWaitlistEntryInput,
  RemoveWaitlistEntrySchema,
  type UpdateWaitlistEntryInput,
  UpdateWaitlistEntrySchema,
  WaitlistEntryParamsSchema,
  type WaitlistEntryResult,
  WaitlistEntryResultSchema,
  type WaitlistSummary,
  WaitlistSummarySchema,
} from "@clubadmin/shared";
import { Body, Controller, Param, Query } from "@nestjs/common";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  CurrentAuthorization,
  PersonPresenter,
  type RequestAuthorization,
  resourceOf,
  tenantContext,
} from "../authorization/index.ts";
import type { WaitlistEntry } from "../groups/index.ts";
import { PeopleService } from "../people/index.ts";
import { type Applicant, WaitlistsService } from "./waitlists.service.ts";

const iso = (date: Date | null) => (date ? date.toISOString() : null);
const DAY = 86_400_000;

const result = (e: WaitlistEntry): WaitlistEntryResult => ({
  id: e.id,
  status: e.status,
  offerExpiresAt: iso(e.offerExpiresAt),
  joinRequestId: e.joinRequestId,
});

const manage = { permission: "group.waitlist.manage", resource: "group" } as const;

@Controller()
export class WaitlistsController {
  private readonly waitlists: WaitlistsService;
  private readonly people: PeopleService;
  private readonly presenter: PersonPresenter;

  constructor(waitlists: WaitlistsService, people: PeopleService, presenter: PersonPresenter) {
    this.waitlists = waitlists;
    this.people = people;
    this.presenter = presenter;
  }

  // --- Applicants ------------------------------------------------------------------------

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/open-groups",
    summary:
      "The club's groups that take applications for their waiting lists (no people); insiders also see non-public ones",
    tags: ["joining", "waitlists"],
    access: { authenticated: true },
    request: { params: ClubParamsSchema },
    response: OpenGroupsSchema,
    accountLimit: "joining",
  })
  async openGroups(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("clubId") clubId: string,
  ): Promise<OpenGroups> {
    const insider = authz.actor.isClubMember(clubId) || authz.actor.isGuardianOfClubMember(clubId);
    const rows = await this.waitlists.openGroups(authz.context, clubId, insider);
    return {
      items: rows.map((r) => ({
        ...r,
        kind: r.kind as OpenGroups["items"][number]["kind"],
        genderCategory: r.genderCategory as OpenGroups["items"][number]["genderCategory"],
      })),
    };
  }

  @Endpoint({
    method: "POST",
    path: "groups/:groupId/waitlist",
    summary:
      "Put yourself or a child on a group's waiting list; outside the club this also asks to join the club",
    tags: ["joining", "waitlists"],
    access: { authenticated: true },
    request: { params: GroupParamsSchema, body: ApplyWaitlistSchema },
    response: WaitlistEntryResultSchema,
    accountLimit: "joining",
  })
  async apply(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("groupId") groupId: string,
    @Body() body: ApplyWaitlistInput,
  ): Promise<WaitlistEntryResult> {
    if (!this.applicant(authz).actsFor(body.personId)) throw new DomainError("not_found");
    const clubId = await this.waitlists.clubOfGroup(authz.context, groupId);
    const { entry } = await this.waitlists.apply(tenantContext(authz, clubId), groupId, body);
    return result(entry);
  }

  @Endpoint({
    method: "POST",
    path: "me/waitlists/:entryId/withdraw",
    summary: "Leave a waiting list (also withdraws a join request made with it)",
    tags: ["me", "waitlists"],
    access: { authenticated: true },
    request: { params: MyWaitlistEntryParamsSchema },
    response: OkSchema,
    status: 200,
  })
  async withdraw(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("entryId") entryId: string,
  ): Promise<{ ok: true }> {
    await this.waitlists.withdraw(authz.context, entryId, this.applicant(authz));
    return { ok: true };
  }

  @Endpoint({
    method: "POST",
    path: "me/waitlists/:entryId/accept",
    summary: "Accept an offered place before it expires",
    tags: ["me", "waitlists"],
    access: { authenticated: true },
    request: { params: MyWaitlistEntryParamsSchema },
    response: WaitlistEntryResultSchema,
    status: 200,
  })
  async accept(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("entryId") entryId: string,
  ): Promise<WaitlistEntryResult> {
    return result(await this.waitlists.accept(authz.context, entryId, this.applicant(authz)));
  }

  @Endpoint({
    method: "POST",
    path: "me/waitlists/:entryId/decline",
    summary: "Decline an offered place (the entry closes)",
    tags: ["me", "waitlists"],
    access: { authenticated: true },
    request: { params: MyWaitlistEntryParamsSchema },
    response: OkSchema,
    status: 200,
  })
  async decline(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("entryId") entryId: string,
  ): Promise<{ ok: true }> {
    await this.waitlists.decline(authz.context, entryId, this.applicant(authz));
    return { ok: true };
  }

  // --- Owners ---------------------------------------------------------------------------

  @Endpoint({
    method: "GET",
    path: "groups/:groupId/waitlist",
    summary:
      "The group's waiting list in fair order (priority, then time), or recently closed entries",
    tags: ["groups", "waitlists"],
    access: manage,
    request: { params: GroupParamsSchema, query: GroupWaitlistQuerySchema },
    response: GroupWaitlistSchema,
    bulkRead: true,
  })
  async list(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: GroupWaitlistQuery,
  ): Promise<GroupWaitlist> {
    const group = resourceOf(authz, "group");
    const page = await this.waitlists.list(
      tenantContext(authz, group.clubId),
      group.groupId,
      query,
    );
    const ids = page.items.flatMap((e) => [e.personId, e.requestedByPersonId]);
    const rows = await this.people.summaries(tenantContext(authz, group.clubId), [...new Set(ids)]);
    // Owners of the group (or a parent), managers and registrars see
    // protected applicants with the icon.
    const shown = new Map(
      (await this.presenter.present(authz, group.clubId, rows, { group })).map((p) => [p.id, p]),
    );
    return {
      items: page.items.flatMap((e) => {
        const person = shown.get(e.personId);
        if (!person) return [];
        return [
          {
            id: e.id,
            person,
            status: e.status,
            position: e.position,
            requestedBy:
              e.requestedByPersonId === e.personId
                ? null
                : (shown.get(e.requestedByPersonId) ?? null),
            birthYear: e.birthYear,
            fitsBirthYears: e.fitsBirthYears,
            fitsGenderCategory: e.fitsGenderCategory,
            queuedAt: e.queuedAt.toISOString(),
            priority: e.priority,
            priorityReason: e.priorityReason,
            applicantNote: e.applicantNote,
            ownerNote: e.ownerNote,
            offeredAt: iso(e.offeredAt),
            offerExpiresAt: iso(e.offerExpiresAt),
            autoOffer: e.autoOffer,
            outOfOrderReason: e.outOfOrderReason,
            closedReason: e.closedReason,
            decidedAt: iso(e.decidedAt),
            awaitingClub: e.awaitingClub,
          },
        ];
      }),
      nextCursor: page.nextCursor,
    };
  }

  @Endpoint({
    method: "GET",
    path: "groups/:groupId/waitlist/summary",
    summary: "Places, waiting, offers out and accepted entries awaiting the club",
    tags: ["groups", "waitlists"],
    access: manage,
    request: { params: GroupParamsSchema },
    response: WaitlistSummarySchema,
  })
  async summary(@CurrentAuthorization() authz: RequestAuthorization): Promise<WaitlistSummary> {
    const group = resourceOf(authz, "group");
    const s = await this.waitlists.summary(tenantContext(authz, group.clubId), group.groupId);
    return {
      admissionMode: s.group.admissionMode,
      autoOffer: s.group.waitlistAutoOffer,
      offerReplyDays: s.group.offerReplyDays,
      capacity: s.capacity,
      occupied: s.occupied,
      free: s.capacity === null ? null : Math.max(0, s.capacity - s.occupied),
      waiting: s.waiting,
      offers: s.offers,
      accepted: s.accepted,
    };
  }

  @Endpoint({
    method: "PATCH",
    path: "groups/:groupId/waitlist/:entryId",
    summary: "Change an entry's priority (with a reason) or the owners' note",
    tags: ["groups", "waitlists"],
    access: manage,
    request: { params: WaitlistEntryParamsSchema, body: UpdateWaitlistEntrySchema },
    response: WaitlistEntryResultSchema,
  })
  async update(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("entryId") entryId: string,
    @Body() body: UpdateWaitlistEntryInput,
  ): Promise<WaitlistEntryResult> {
    const group = resourceOf(authz, "group");
    return result(
      await this.waitlists.update(tenantContext(authz, group.clubId), group.groupId, entryId, body),
    );
  }

  @Endpoint({
    method: "POST",
    path: "groups/:groupId/waitlist/:entryId/offer",
    summary: "Offer a place until the end of the reply day; skipping anyone needs a reason",
    tags: ["groups", "waitlists"],
    access: manage,
    request: { params: WaitlistEntryParamsSchema, body: OfferWaitlistEntrySchema },
    response: WaitlistEntryResultSchema,
    status: 200,
  })
  async offer(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("entryId") entryId: string,
    @Body() body: OfferWaitlistEntryInput,
  ): Promise<WaitlistEntryResult> {
    const group = resourceOf(authz, "group");
    return result(
      await this.waitlists.offer(tenantContext(authz, group.clubId), group.groupId, entryId, body),
    );
  }

  @Endpoint({
    method: "POST",
    path: "groups/:groupId/waitlist/:entryId/withdraw-offer",
    summary: "Withdraw an offer: the entry is back in line with its original time",
    tags: ["groups", "waitlists"],
    access: manage,
    request: { params: WaitlistEntryParamsSchema },
    response: WaitlistEntryResultSchema,
    status: 200,
  })
  async withdrawOffer(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("entryId") entryId: string,
  ): Promise<WaitlistEntryResult> {
    const group = resourceOf(authz, "group");
    return result(
      await this.waitlists.withdrawOffer(
        tenantContext(authz, group.clubId),
        group.groupId,
        entryId,
      ),
    );
  }

  @Endpoint({
    method: "POST",
    path: "groups/:groupId/waitlist/:entryId/admit",
    summary: "Admit directly, without an offer; skipping anyone needs a reason",
    tags: ["groups", "waitlists"],
    access: manage,
    request: { params: WaitlistEntryParamsSchema, body: AdmitWaitlistEntrySchema },
    response: WaitlistEntryResultSchema,
    status: 200,
  })
  async admit(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("entryId") entryId: string,
    @Body() body: AdmitWaitlistEntryInput,
  ): Promise<WaitlistEntryResult> {
    const group = resourceOf(authz, "group");
    return result(
      await this.waitlists.admit(tenantContext(authz, group.clubId), group.groupId, entryId, body),
    );
  }

  @Endpoint({
    method: "POST",
    path: "groups/:groupId/waitlist/:entryId/remove",
    summary: "Remove an entry with a reason; the applicant is told the reason, never the note",
    tags: ["groups", "waitlists"],
    access: manage,
    request: { params: WaitlistEntryParamsSchema, body: RemoveWaitlistEntrySchema },
    response: WaitlistEntryResultSchema,
    status: 200,
  })
  async remove(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("entryId") entryId: string,
    @Body() body: RemoveWaitlistEntryInput,
  ): Promise<WaitlistEntryResult> {
    const group = resourceOf(authz, "group");
    return result(
      await this.waitlists.remove(
        tenantContext(authz, group.clubId),
        group.groupId,
        entryId,
        body.reason,
      ),
    );
  }

  // --- Club managers ---------------------------------------------------------------------

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/waitlists",
    summary:
      "All waiting lists of the club, and the out-of-order decisions and queue bypasses with their reasons",
    tags: ["clubs", "waitlists"],
    access: { permission: "club.waitlists.read", resource: "club" },
    request: { params: ClubParamsSchema, query: ClubWaitlistsQuerySchema },
    response: ClubWaitlistsSchema,
  })
  async club(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: ClubWaitlistsQuery,
  ): Promise<ClubWaitlists> {
    const { clubId } = resourceOf(authz, "club");
    const context = tenantContext(authz, clubId);
    const from = query.from
      ? new Date(`${query.from}T00:00:00Z`)
      : new Date(Date.now() - 365 * DAY);
    const view = await this.waitlists.clubView(context, {
      from,
      cursor: query.cursor ?? null,
      limit: query.limit,
    });
    const ids = view.decisions.flatMap((d) =>
      d.decidedByPersonId ? [d.personId, d.decidedByPersonId] : [d.personId],
    );
    const shown = await this.presentIds(authz, clubId, ids);
    return {
      groups: view.groups.map((g) => ({
        id: g.id,
        name: g.name,
        capacity: g.capacity,
        occupied: g.occupied,
        free: g.capacity === null ? null : Math.max(0, g.capacity - g.occupied),
        waiting: g.waiting,
        offers: g.offers,
        accepted: g.accepted,
      })),
      decisions: view.decisions.flatMap((d) => {
        const person = shown.get(d.personId);
        if (!person) return [];
        return [
          {
            id: d.id,
            kind: d.kind,
            group: { id: d.groupId, name: d.groupName },
            person,
            decidedBy: d.decidedByPersonId ? (shown.get(d.decidedByPersonId) ?? null) : null,
            decidedAt: d.decidedAt.toISOString(),
            reason: d.reason,
          },
        ];
      }),
      nextCursor: view.nextCursor,
    };
  }

  private applicant(authz: RequestAuthorization): Applicant {
    const actor = authz.actor;
    return {
      personIds: [
        actor.relationships.personId,
        ...actor.relationships.wards.map((w) => w.personId),
      ],
      actsFor: (personId) =>
        actor.isSelf(personId) || actor.isGuardianOf(personId, "act_on_behalf"),
    };
  }

  private async presentIds(
    authz: RequestAuthorization,
    clubId: string,
    ids: readonly string[],
  ): Promise<Map<string, PersonSummary>> {
    const rows = await this.people.summaries(tenantContext(authz, clubId), [...new Set(ids)]);
    return new Map((await this.presenter.present(authz, clubId, rows)).map((p) => [p.id, p]));
  }
}
