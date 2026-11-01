// SPDX-License-Identifier: AGPL-3.0-only
// Consents (P1.8a): my consents and my wards', one person's in a club, and
// a group's overview for its leaders. People only through the presenter.

import { type Locale, negotiateLocale } from "@clubadmin/i18n";
import {
  ClubQuerySchema,
  ConsentPurposeParamsSchema,
  type ConsentStatus,
  type GiveConsentInput,
  GiveConsentSchema,
  type GroupConsents,
  type GroupConsentsQuery,
  GroupConsentsQuerySchema,
  GroupConsentsSchema,
  GroupParamsSchema,
  type MyConsents,
  MyConsentsSchema,
  type PersonConsents,
  PersonConsentsSchema,
  PersonParamsSchema,
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
  resourceOf,
  tenantContext,
} from "../authorization/index.ts";
import { PeopleService } from "../people/index.ts";
import { type ConsentCaller, ConsentsService, type PurposeStatus } from "./consents.service.ts";
import type { ConsentRow } from "./privacy.repository.ts";
import { renderConsentText } from "./privacy-texts.ts";

const EmptySchema = z.object({}).openapi("Empty");

/** Who the caller is for the person's consents in the club. */
function callerOf(
  authz: RequestAuthorization,
  personId: string,
  clubId: string,
): ConsentCaller | "leader" {
  const actor = authz.actor;
  if (actor.onBehalfOf === personId) return "guardian";
  if (actor.isSelf(personId)) return "self";
  if (actor.isFullGuardianOf(personId)) return "guardian";
  if (actor.hasClubRole(clubId, "club_manager", "registrar")) return "admin";
  return "leader";
}

export const localeOfRequest = (request: FastifyRequest): Locale =>
  negotiateLocale(request.headers["accept-language"]);

@Controller()
export class ConsentsController {
  private readonly consents: ConsentsService;
  private readonly people: PeopleService;
  private readonly presenter: PersonPresenter;

  constructor(consents: ConsentsService, people: PeopleService, presenter: PersonPresenter) {
    this.consents = consents;
    this.people = people;
    this.presenter = presenter;
  }

  @Endpoint({
    method: "GET",
    path: "me/consents",
    summary: "My consents and my children's, per club, with the texts in my language",
    tags: ["privacy"],
    access: { authenticated: true },
    response: MyConsentsSchema,
  })
  async mine(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Req() request: FastifyRequest,
  ): Promise<MyConsents> {
    const locale = localeOfRequest(request);
    const wards = authz.actor.relationships.wards
      .filter((w) => authz.actor.isFullGuardianOf(w.personId))
      .map((w) => w.personId);
    const overview = await this.consents.overview(authz.context, wards);
    const people = new Map(
      (
        await this.people.summaries(authz.context, [
          ...new Set(
            overview.clubs.flatMap((c) =>
              c.people.flatMap((p) => [
                p.personId,
                ...p.purposes.flatMap((s) => (s.open ? [s.open.givenByPersonId] : [])),
              ]),
            ),
          ),
        ])
      ).map((p) => [p.id, p]),
    );
    const clubs: MyConsents["clubs"] = [];
    for (const club of overview.clubs) {
      const shown = new Map(
        (await this.presenter.present(authz, club.clubId, [...people.values()])).map((s) => [
          s.id,
          s,
        ]),
      );
      const texts = club.purposes.map((purpose) => ({
        purpose,
        ...renderConsentText(locale, purpose, club.texts.get(purpose), {
          name: club.clubName,
          defaultLocale: club.defaultLocale,
        }),
      }));
      clubs.push({
        clubId: club.clubId,
        clubName: club.clubName,
        texts,
        people: club.people.flatMap((p) => {
          const person = shown.get(p.personId);
          return person ? [{ person, purposes: p.purposes.map((s) => statusOf(s, shown)) }] : [];
        }),
      });
    }
    return { clubs };
  }

  @Endpoint({
    method: "GET",
    path: "people/:personId/consents",
    summary: "A person's consents in a club (status; history for the family and administrators)",
    tags: ["privacy"],
    access: { permission: "person.consents.read", resource: "person" },
    request: { params: PersonParamsSchema, query: ClubQuerySchema },
    response: PersonConsentsSchema,
  })
  async personConsents(
    @CurrentAuthorization() authz: RequestAuthorization,
  ): Promise<PersonConsents> {
    const { personId, clubId } = resourceOf(authz, "person");
    const club = clubId!;
    const caller = callerOf(authz, personId, club);
    const result = await this.consents.personConsents(tenantContext(authz, club), personId, caller);
    const givers = await this.people.summaries(tenantContext(authz, club), [
      ...new Set(result.history.map((h) => h.givenByPersonId)),
      ...result.statuses.flatMap((s) => (s.open ? [s.open.givenByPersonId] : [])),
    ]);
    const shown = new Map(
      (await this.presenter.present(authz, club, givers)).map((s) => [s.id, s]),
    );
    const admin = caller === "admin";
    return {
      personId,
      clubId: club,
      purposes: result.statuses.map((s) => statusOf(s, shown)),
      ...(caller === "leader"
        ? {}
        : {
            history: result.history.map((h) => historyOf(h, shown, admin)),
          }),
      mayRecord: admin,
    };
  }

  @Endpoint({
    method: "PUT",
    path: "people/:personId/consents/:purpose",
    summary: "Give a consent for the club's current text (registrars: record a paper consent)",
    tags: ["privacy"],
    access: { permission: "person.consents.manage", resource: "person" },
    request: {
      params: ConsentPurposeParamsSchema,
      query: ClubQuerySchema,
      body: GiveConsentSchema,
    },
    response: EmptySchema,
  })
  async give(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof ConsentPurposeParamsSchema>,
    @Body() body: GiveConsentInput,
  ): Promise<Record<string, never>> {
    const { personId, clubId } = resourceOf(authz, "person");
    const caller = callerOf(authz, personId, clubId!);
    if (caller === "leader") return {};
    await this.consents.give(tenantContext(authz, clubId!), caller, personId, params.purpose, body);
    return {};
  }

  @Endpoint({
    method: "DELETE",
    path: "people/:personId/consents/:purpose",
    summary: "Withdraw a consent, with immediate effect",
    tags: ["privacy"],
    access: { permission: "person.consents.manage", resource: "person" },
    request: { params: ConsentPurposeParamsSchema, query: ClubQuerySchema },
    response: EmptySchema,
    clubAccess: "export",
  })
  async withdraw(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: z.infer<typeof ConsentPurposeParamsSchema>,
  ): Promise<Record<string, never>> {
    const { personId, clubId } = resourceOf(authz, "person");
    const caller = callerOf(authz, personId, clubId!);
    if (caller === "leader") return {};
    await this.consents.withdraw(tenantContext(authz, clubId!), caller, personId, params.purpose);
    return {};
  }

  @Endpoint({
    method: "GET",
    path: "groups/:groupId/consents",
    summary: "Who in the group has consented to what (leaders: whom not to photograph)",
    tags: ["privacy"],
    access: { permission: "group.consents.read", resource: "group" },
    request: { params: GroupParamsSchema, query: GroupConsentsQuerySchema },
    response: GroupConsentsSchema,
    bulkRead: true,
  })
  async groupConsents(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: GroupConsentsQuery,
  ): Promise<GroupConsents> {
    const group = resourceOf(authz, "group");
    const context = tenantContext(authz, group.clubId);
    const result = await this.consents.groupConsents(context, group.groupId, query);
    const shown = new Map(
      (
        await this.presenter.present(
          authz,
          group.clubId,
          await this.people.summaries(
            context,
            result.items.map((i) => i.personId),
          ),
        )
      ).map((s) => [s.id, s]),
    );
    return {
      purposes: result.purposes,
      counts: result.counts,
      items: result.items.flatMap((item) => {
        const person = shown.get(item.personId);
        if (!person) return [];
        return [
          {
            person,
            consents: result.purposes.map((purpose) => ({
              purpose,
              status: item.given.has(purpose)
                ? ("given" as const)
                : item.protected &&
                    [
                      "photo_publication",
                      "video_publication",
                      "streaming",
                      "contacts_group",
                      "contacts_club",
                    ].includes(purpose)
                  ? ("not_applicable" as const)
                  : ("missing" as const),
            })),
          },
        ];
      }),
      nextCursor: result.nextCursor,
    };
  }
}

function statusOf(s: PurposeStatus, shown: Map<string, PersonSummary>): ConsentStatus {
  return {
    purpose: s.purpose,
    applicable: s.applicable,
    consent: s.open
      ? {
          textVersion: s.open.textVersion,
          current: s.current,
          source: s.open.source,
          givenAt: s.open.givenAt.toISOString(),
          givenBy: shown.get(s.open.givenByPersonId) ?? null,
        }
      : null,
    mayGive: s.mayGive,
    mayWithdraw: s.mayWithdraw,
  };
}

function historyOf(h: ConsentRow, shown: Map<string, PersonSummary>, admin: boolean) {
  return {
    purpose: h.purpose,
    textVersion: h.textVersion,
    source: h.source,
    givenAt: h.givenAt.toISOString(),
    givenBy: shown.get(h.givenByPersonId) ?? null,
    revokedAt: h.revokedAt ? h.revokedAt.toISOString() : null,
    revokedReason: h.revokedReason,
    ...(admin ? { clubNote: h.clubNote } : {}),
  };
}
