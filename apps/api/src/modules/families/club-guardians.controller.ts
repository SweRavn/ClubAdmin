// SPDX-License-Identifier: AGPL-3.0-only
// Families (P1.3) as the club sees them: guardians of a member, adding one
// from a paper application or form, ending one, and duplicates among the
// club's members. Club managers and registrars; ending a full guardian's
// guardianship needs a club manager with a second factor and a reason.

import {
  type ClubAddGuardianInput,
  ClubAddGuardianSchema,
  type ClubDuplicates,
  type ClubDuplicatesQuery,
  ClubDuplicatesQuerySchema,
  ClubDuplicatesSchema,
  type ClubEndGuardianshipInput,
  ClubEndGuardianshipSchema,
  type ClubGuardians,
  ClubGuardianshipParamsSchema,
  ClubGuardiansSchema,
  ClubParamsSchema,
  type GuardianshipCreated,
  GuardianshipCreatedSchema,
  isFullGuardianshipKind,
  MemberParamsSchema,
  OkSchema,
} from "@clubadmin/shared";
import { Body, Controller, Param, Query } from "@nestjs/common";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  CurrentAuthorization,
  FamilyPresenter,
  type GuardianPerson,
  PersonPresenter,
  type RequestAuthorization,
  resourceOf,
  tenantContext,
} from "../authorization/index.ts";
import { GuardianshipsService } from "../guardianships/index.ts";
import { PeopleService } from "../people/index.ts";
import { PersonMergeService } from "../person-merge/index.ts";
import { asSelf } from "./family.controller.ts";

@Controller("clubs")
export class ClubGuardiansController {
  private readonly guardianships: GuardianshipsService;
  private readonly people: PeopleService;
  private readonly merges: PersonMergeService;
  private readonly presenter: PersonPresenter;
  private readonly family: FamilyPresenter;

  constructor(
    guardianships: GuardianshipsService,
    people: PeopleService,
    merges: PersonMergeService,
    presenter: PersonPresenter,
    family: FamilyPresenter,
  ) {
    this.guardianships = guardianships;
    this.people = people;
    this.merges = merges;
    this.presenter = presenter;
    this.family = family;
  }

  @Endpoint({
    method: "GET",
    path: ":clubId/members/:personId/guardians",
    summary: "A member's guardians, relatives and contact persons as the club sees them",
    tags: ["families"],
    access: { permission: "club.guardians.manage", resource: "club" },
    request: { params: MemberParamsSchema },
    response: ClubGuardiansSchema,
  })
  async list(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("personId") personId: string,
  ): Promise<ClubGuardians> {
    const { clubId } = resourceOf(authz, "club");
    const context = tenantContext(authz, clubId, { viewerPrivileged: true });
    const rows = await this.guardianships.clubGuardians(context, personId);
    const [ward] = await this.people.summaries(context, [personId]);
    const shownWard = ward ? await this.presenter.presentOne(authz, clubId, ward) : null;
    if (!shownWard) throw new DomainError("not_found");
    const people = await this.people.getPeople(
      context,
      rows.map((r) => r.guardianPersonId),
    );
    const byId = new Map<string, GuardianPerson>(people.map((p) => [p.id, p]));
    const manager = authz.actor.isClubManager(clubId);
    const entries = await this.family.guardians(authz, clubId, rows, byId, {
      personId: authz.principal.personId,
      fullGuardian: false,
      ward: false,
      wardMayLink: false,
      minor: true,
      clubAdmin: true,
    });
    const recorded = new Map(rows.map((r) => [r.id, r.recordedByClubId === clubId]));
    return {
      ward: shownWard,
      guardians: entries.map((e) => ({
        ...e,
        canEnd: isFullGuardianshipKind(e.kind)
          ? manager
          : manager || recorded.get(e.guardianshipId) === true,
        canChangeRights: false,
      })),
    };
  }

  @Endpoint({
    method: "POST",
    path: ":clubId/members/:personId/guardians",
    summary:
      "Record a guardian from a paper application: a member of the club or a new person without login",
    tags: ["families"],
    access: { permission: "club.guardians.manage", resource: "club" },
    request: { params: MemberParamsSchema, body: ClubAddGuardianSchema },
    response: GuardianshipCreatedSchema,
  })
  async add(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("personId") personId: string,
    @Body() body: ClubAddGuardianInput,
  ): Promise<GuardianshipCreated> {
    const { clubId } = resourceOf(authz, "club");
    asSelf(authz);
    const context = tenantContext(authz, clubId, { viewerPrivileged: true });
    const recorded = await this.guardianships.recordGuardian(context, {
      wardPersonId: personId,
      guardian: body.guardian,
      kind: body.kind,
      rights: body.rights,
      consentNote: body.consentNote,
    });
    const [person] = await this.people.summaries(context, [recorded.personId]);
    const shown = person ? await this.presenter.presentOne(authz, clubId, person) : null;
    if (!shown) throw new DomainError("not_found");
    return { guardianshipId: recorded.guardianship.id, person: shown };
  }

  @Endpoint({
    method: "POST",
    path: ":clubId/guardianships/:guardianshipId/end",
    summary:
      "End a guardianship of a member: links the club recorded; a full guardian's only by a club manager (second factor, reason)",
    tags: ["families"],
    access: { permission: "club.guardians.manage", resource: "club" },
    request: { params: ClubGuardianshipParamsSchema, body: ClubEndGuardianshipSchema },
    response: OkSchema,
    status: 200,
  })
  async end(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("guardianshipId") guardianshipId: string,
    @Body() body: ClubEndGuardianshipInput,
  ): Promise<{ ok: true }> {
    const { clubId } = resourceOf(authz, "club");
    asSelf(authz);
    const manager = authz.actor.isClubManager(clubId) && authz.actor.mfa;
    await this.guardianships.endGuardianship(tenantContext(authz, clubId), guardianshipId, {
      allowedBy: manager ? "club_manager" : "club",
      ...(body.reason ? { reason: body.reason } : {}),
    });
    return { ok: true };
  }

  @Endpoint({
    method: "GET",
    path: ":clubId/duplicates",
    summary:
      "Pairs of the club's members that look like the same person (birth date and family name, or personal identity number)",
    tags: ["families"],
    access: { permission: "club.guardians.manage", resource: "club" },
    request: { params: ClubParamsSchema, query: ClubDuplicatesQuerySchema },
    response: ClubDuplicatesSchema,
    bulkRead: true,
  })
  async duplicates(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: ClubDuplicatesQuery,
  ): Promise<ClubDuplicates> {
    const { clubId } = resourceOf(authz, "club");
    const context = tenantContext(authz, clubId, { viewerPrivileged: true });
    const after = query.cursor ? (query.cursor.split(":") as [string, string]) : null;
    const rows = await this.merges.clubDuplicates(context, { after, limit: query.limit + 1 });
    const page = rows.slice(0, query.limit);
    const ids = [...new Set(page.flatMap((r) => [r.personId, r.duplicatePersonId]))];
    const shown = new Map(
      (await this.presenter.present(authz, clubId, await this.people.summaries(context, ids))).map(
        (p) => [p.id, p],
      ),
    );
    const last = page.at(-1);
    return {
      items: page.flatMap((r) => {
        const person = shown.get(r.personId);
        const duplicate = shown.get(r.duplicatePersonId);
        return person && duplicate
          ? [{ person, duplicate, birthDate: r.birthDate, reason: r.reason }]
          : [];
      }),
      nextCursor:
        rows.length > query.limit && last ? `${last.personId}:${last.duplicatePersonId}` : null,
    };
  }
}
