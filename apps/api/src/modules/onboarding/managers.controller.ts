// SPDX-License-Identifier: AGPL-3.0-only
// Club managers (ADR 0018, P1.1): appoint, remove or step down, hand over
// (the successor accepts first), and recovery by the board chair or an
// operator. A club always keeps at least one manager.

import {
  AppointManagerSchema,
  ClubParamsSchema,
  HandoverParamsSchema,
  type HandoverResponse,
  HandoverSchema,
  type ManagerList,
  ManagerListSchema,
  ManagerParamsSchema,
  type MyHandovers,
  MyHandoversSchema,
  OkSchema,
  type PersonSummary,
  ProposeHandoverSchema,
  type ReassignManagerInput,
  ReassignManagerSchema,
} from "@clubadmin/shared";
import { Body, Controller, Param } from "@nestjs/common";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  CurrentAuthorization,
  operatorTenant,
  PersonPresenter,
  type RequestAuthorization,
  resourceOf,
  tenantContext,
} from "../authorization/index.ts";
import { ClubsService } from "../clubs/index.ts";
import { PeopleService } from "../people/index.ts";
import { type Handover, RolesService } from "../roles/index.ts";
import { OnboardingService } from "./onboarding.service.ts";

@Controller()
export class ManagersController {
  private readonly onboarding: OnboardingService;
  private readonly roles: RolesService;
  private readonly clubs: ClubsService;
  private readonly people: PeopleService;
  private readonly presenter: PersonPresenter;

  constructor(
    onboarding: OnboardingService,
    roles: RolesService,
    clubs: ClubsService,
    people: PeopleService,
    presenter: PersonPresenter,
  ) {
    this.onboarding = onboarding;
    this.roles = roles;
    this.clubs = clubs;
    this.people = people;
    this.presenter = presenter;
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/managers",
    summary: "The club's managers, longest-serving first",
    tags: ["clubs"],
    access: { permission: "club.read", resource: "club" },
    request: { params: ClubParamsSchema },
    response: ManagerListSchema,
  })
  async list(@CurrentAuthorization() authz: RequestAuthorization): Promise<ManagerList> {
    const { clubId } = resourceOf(authz, "club");
    const managers = await this.onboarding.managers(tenantContext(authz, clubId));
    const shown = await this.present(
      authz,
      clubId,
      managers.map((m) => m.personId),
    );
    return {
      items: managers.flatMap((m) => {
        const person = shown.get(m.personId);
        return person ? [{ person, since: m.validFrom.toISOString() }] : [];
      }),
    };
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/managers",
    summary: "Appoint an active member as another club manager",
    tags: ["clubs"],
    access: { permission: "club.roles.manage", resource: "club" },
    request: { params: ClubParamsSchema, body: AppointManagerSchema },
    response: OkSchema,
  })
  async appoint(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: { personId: string },
  ): Promise<{ ok: true }> {
    const { clubId } = resourceOf(authz, "club");
    await this.onboarding.appointManager(tenantContext(authz, clubId), body.personId);
    return { ok: true };
  }

  @Endpoint({
    method: "DELETE",
    path: "clubs/:clubId/managers/:personId",
    summary: "Remove a manager, or step down yourself (never the last manager)",
    tags: ["clubs"],
    access: { permission: "club.roles.manage", resource: "club" },
    request: { params: ManagerParamsSchema },
    response: OkSchema,
  })
  async remove(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("personId") personId: string,
  ): Promise<{ ok: true }> {
    const { clubId } = resourceOf(authz, "club");
    await this.onboarding.removeManager(tenantContext(authz, clubId), personId);
    return { ok: true };
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/manager-handovers",
    summary: "Propose a successor: they become manager and you step down when they accept",
    tags: ["clubs"],
    access: { permission: "club.roles.manage", resource: "club" },
    request: { params: ClubParamsSchema, body: ProposeHandoverSchema },
    response: HandoverSchema,
  })
  async propose(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: { toPersonId: string },
  ): Promise<HandoverResponse> {
    const { clubId } = resourceOf(authz, "club");
    const handover = await this.onboarding.proposeHandover(
      tenantContext(authz, clubId),
      body.toPersonId,
    );
    const [response] = await this.toResponses(authz, [handover]);
    return response!;
  }

  @Endpoint({
    method: "GET",
    path: "me/manager-handovers",
    summary: "Open hand-over proposals to and from me",
    tags: ["me", "clubs"],
    access: { authenticated: true },
    response: MyHandoversSchema,
  })
  async mine(@CurrentAuthorization() authz: RequestAuthorization): Promise<MyHandovers> {
    const me = authz.context.personId;
    const handovers = await this.roles.myOpenHandovers(authz.context);
    const responses = await this.toResponses(authz, handovers);
    return {
      incoming: responses.filter((_, i) => handovers[i]!.toPersonId === me),
      outgoing: responses.filter((_, i) => handovers[i]!.fromPersonId === me),
    };
  }

  @Endpoint({
    method: "POST",
    path: "manager-handovers/:handoverId/accept",
    summary: "Accept a hand-over: become manager; the proposer steps down",
    tags: ["clubs"],
    access: { permission: "club.handover.respond", resource: "handover" },
    request: { params: HandoverParamsSchema },
    response: OkSchema,
    status: 200,
  })
  async accept(@CurrentAuthorization() authz: RequestAuthorization): Promise<{ ok: true }> {
    const handover = resourceOf(authz, "handover");
    await this.roles.acceptHandover(tenantContext(authz, handover.clubId), handover.handoverId);
    return { ok: true };
  }

  @Endpoint({
    method: "POST",
    path: "manager-handovers/:handoverId/decline",
    summary: "Decline a hand-over proposed to you",
    tags: ["clubs"],
    access: { permission: "club.handover.respond", resource: "handover" },
    request: { params: HandoverParamsSchema },
    response: OkSchema,
    status: 200,
  })
  async decline(@CurrentAuthorization() authz: RequestAuthorization): Promise<{ ok: true }> {
    const handover = resourceOf(authz, "handover");
    await this.roles.declineHandover(tenantContext(authz, handover.clubId), handover.handoverId);
    return { ok: true };
  }

  @Endpoint({
    method: "POST",
    path: "manager-handovers/:handoverId/cancel",
    summary: "Cancel your own hand-over proposal",
    tags: ["clubs"],
    access: { permission: "club.handover.respond", resource: "handover" },
    request: { params: HandoverParamsSchema },
    response: OkSchema,
    status: 200,
  })
  async cancel(@CurrentAuthorization() authz: RequestAuthorization): Promise<{ ok: true }> {
    const handover = resourceOf(authz, "handover");
    await this.roles.cancelHandover(tenantContext(authz, handover.clubId), handover.handoverId);
    return { ok: true };
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/managers/claim",
    summary: "Board chair: claim the manager role of a club that has none left",
    tags: ["clubs"],
    access: { permission: "club.managers.claim", resource: "club" },
    request: { params: ClubParamsSchema },
    response: OkSchema,
    status: 200,
  })
  async claim(@CurrentAuthorization() authz: RequestAuthorization): Promise<{ ok: true }> {
    const { clubId } = resourceOf(authz, "club");
    await this.onboarding.claimManager(tenantContext(authz, clubId));
    return { ok: true };
  }

  @Endpoint({
    method: "POST",
    path: "ops/clubs/:clubId/managers",
    summary: "Operator: appoint a manager on the club's documented request (reason recorded)",
    tags: ["ops"],
    access: { permission: "club.managers.reassign", resource: "club" },
    request: { params: ClubParamsSchema, body: ReassignManagerSchema },
    response: OkSchema,
    clubAccess: "exempt",
  })
  async reassign(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: ReassignManagerInput,
  ): Promise<{ ok: true }> {
    const { clubId } = resourceOf(authz, "club");
    await this.onboarding.reassignManager(
      operatorTenant(authz.context, clubId),
      body.personId,
      body.reason,
    );
    return { ok: true };
  }

  /** Hand-overs with their club and the two people, as the viewer may see them. */
  private async toResponses(
    authz: RequestAuthorization,
    handovers: readonly Handover[],
  ): Promise<HandoverResponse[]> {
    const byClub = new Map<string, Handover[]>();
    for (const h of handovers) byClub.set(h.clubId, [...(byClub.get(h.clubId) ?? []), h]);
    const shown = new Map<string, Map<string, PersonSummary>>();
    const names = new Map<string, string>();
    for (const [clubId, items] of byClub) {
      const context = tenantContext(authz, clubId);
      const club = await this.clubs.getClub(context);
      names.set(clubId, club.name);
      shown.set(
        clubId,
        await this.present(
          authz,
          clubId,
          items.flatMap((h) => [h.fromPersonId, h.toPersonId]),
        ),
      );
    }
    return handovers.map((h) => {
      const people = shown.get(h.clubId);
      if (!people) throw new DomainError("not_found");
      return {
        id: h.id,
        club: { id: h.clubId, name: names.get(h.clubId) ?? "" },
        from: people.get(h.fromPersonId) ?? null,
        to: people.get(h.toPersonId) ?? null,
        status: h.status,
        expiresAt: h.expiresAt.toISOString(),
      };
    });
  }

  private async present(
    authz: RequestAuthorization,
    clubId: string,
    ids: readonly string[],
  ): Promise<Map<string, PersonSummary>> {
    const rows = await this.people.summaries(tenantContext(authz, clubId), [...new Set(ids)]);
    return new Map((await this.presenter.present(authz, clubId, rows)).map((p) => [p.id, p]));
  }
}
