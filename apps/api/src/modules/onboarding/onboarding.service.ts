// SPDX-License-Identifier: AGPL-3.0-only
// Getting started and running a club (ADR 0018): completing the profile after
// sign-up, creating a club (or asking an operator to, CLUB_CREATION=approval)
// and the club's managers (appoint, remove, hand over, recovery). Lives
// outside the clubs module because it combines clubs, memberships, roles,
// people and accounts. Who may call what is decided by the authorization
// layer; the service enforces the invariants.

import { getCountryPack, isSupportedCountry } from "@clubadmin/country-packs";
import {
  type ActorContext,
  audit,
  type Database,
  isUniqueViolation,
  outbox,
  type TenantContext,
  type Tx,
} from "@clubadmin/db";
import {
  type ClubCreationRequestStatus,
  type CompleteProfileInput,
  CompleteProfileSchema,
  type CreateClubInput,
  CreateClubSchema,
  uuidv7,
} from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { actorPersonId, parseInput } from "../../platform/domain/run.ts";
import type { AccountsService } from "../accounts/index.ts";
import type { Club, ClubsService } from "../clubs/index.ts";
import type { MembershipsService } from "../memberships/index.ts";
import type { PeopleService,Person } from "../people/index.ts";
import type { Handover, RolesService } from "../roles/index.ts";
import * as repo from "./onboarding.repository.ts";

export type ClubCreationRequest = repo.CreationRequestRow;
export type ClubCreationMode = "open" | "approval" | "operators_only";

const ageOn = (birthDate: string, today: Date): number => {
  const [y, m, d] = birthDate.split("-").map(Number) as [number, number, number];
  const age = today.getUTCFullYear() - y;
  const before =
    today.getUTCMonth() + 1 < m || (today.getUTCMonth() + 1 === m && today.getUTCDate() < d);
  return before ? age - 1 : age;
};

export class OnboardingService {
  private readonly db: Database;
  private readonly clubs: ClubsService;
  private readonly memberships: MembershipsService;
  private readonly roles: RolesService;
  private readonly people: PeopleService | undefined;
  private readonly accounts: AccountsService | undefined;
  private readonly defaultCountry: string;

  constructor(
    db: Database,
    deps: {
      clubs: ClubsService;
      memberships: MembershipsService;
      roles: RolesService;
      people?: PeopleService;
      accounts?: AccountsService;
      defaultCountry?: string;
    },
  ) {
    this.db = db;
    this.clubs = deps.clubs;
    this.memberships = deps.memberships;
    this.roles = deps.roles;
    this.people = deps.people;
    this.accounts = deps.accounts;
    this.defaultCountry = deps.defaultCountry ?? "SE";
  }

  private requirePeople(): { people: PeopleService; accounts: AccountsService } {
    if (!this.people || !this.accounts)
      throw new Error("OnboardingService without people/accounts");
    return { people: this.people, accounts: this.accounts };
  }

  /**
   * The club, its creator as active member (member number 1) and first club
   * manager, in one transaction. `id`: a fixed club ID (the demo seed;
   * ADR 0026). `creatorPersonId`: an operator approving a request creates the
   * club for the requester.
   */
  createClub(
    context: ActorContext,
    input: CreateClubInput,
    options: { id?: string; creatorPersonId?: string } = {},
  ): Promise<Club> {
    const clubContext: TenantContext = { ...context, clubId: options.id ?? uuidv7() };
    return this.db.withTenant(clubContext, (tx) =>
      this.createClubInTx(
        tx,
        clubContext,
        input,
        options.creatorPersonId ?? actorPersonId(context),
      ),
    );
  }

  private async createClubInTx(
    tx: Tx,
    clubContext: TenantContext,
    input: CreateClubInput,
    creator: string,
  ): Promise<Club> {
    const club = await this.clubs.insertClubInTx(tx, clubContext.clubId, input);
    await this.memberships.addMemberInTx(tx, clubContext, creator);
    await this.roles.assignRoleInTx(tx, clubContext, creator, "club_manager");
    return club;
  }

  // --- Profile -------------------------------------------------------------

  myProfile(context: ActorContext): Promise<Person> {
    return this.requirePeople().people.getPerson(context, actorPersonId(context));
  }

  /**
   * Name and birth date after sign-up. A person younger than the country
   * pack's own_account_min_age cannot hold an own account (a guardian adds
   * them instead, P1.3).
   */
  async completeProfile(context: ActorContext, input: CompleteProfileInput): Promise<Person> {
    const { people } = this.requirePeople();
    const data = parseInput(CompleteProfileSchema, input);
    const minAge = getCountryPack(
      isSupportedCountry(this.defaultCountry) ? this.defaultCountry : "SE",
    ).ageRules.ownAccountMinAge;
    if (ageOn(data.birthDate, new Date()) < minAge) throw new DomainError("too_young_for_account");
    const me = actorPersonId(context);
    const current = await people.getPerson(context, me);
    // The birth date is set once here; later changes go through the profile.
    const { birthDate, ...names } = data;
    return people.updateProfile(context, me, current.birthDate ? names : { ...names, birthDate });
  }

  // --- Club creation ---------------------------------------------------------

  /**
   * Creates the club (open, or an operator), or files a request for an
   * operator (approval). The caller needs a verified email and a completed
   * profile.
   */
  async createOrRequest(
    context: ActorContext,
    input: CreateClubInput,
    options: { mode: ClubCreationMode; operator: boolean },
  ): Promise<{ club: Club } | { request: ClubCreationRequest }> {
    const { accounts } = this.requirePeople();
    const data = parseInput(CreateClubSchema, input);
    const me = actorPersonId(context);
    if (options.mode === "operators_only" && !options.operator) {
      throw new DomainError("club_creation_not_allowed");
    }
    if (options.mode === "open" || options.operator) {
      const clubContext: TenantContext = { ...context, clubId: uuidv7() };
      const club = await this.db.withTenant(clubContext, async (tx) => {
        await accounts.requireReadyForClubsInTx(tx, me);
        return this.createClubInTx(tx, clubContext, data, me);
      });
      return { club };
    }
    if (!isSupportedCountry(data.country)) throw new DomainError("unsupported_country");
    return this.db.withActor(context, async (tx) => {
      await accounts.requireReadyForClubsInTx(tx, me);
      let request: ClubCreationRequest;
      try {
        request = await repo.insertRequest(tx, {
          requestedByPersonId: me,
          name: data.name,
          shortName: data.shortName ?? null,
          slug: data.slug,
          country: data.country,
          defaultLocale: data.defaultLocale ?? null,
          timeZone: data.timeZone ?? null,
          currency: data.currency ?? null,
          joinPolicy: data.joinPolicy ?? null,
          organizationNumber: data.organizationNumber ?? null,
        });
      } catch (error) {
        if (isUniqueViolation(error, "club_creation_requests_pending_unique")) {
          throw new DomainError("creation_request_exists");
        }
        throw error;
      }
      await audit.record(tx, {
        action: "club.creation.requested",
        resourceType: "club_creation_request",
        resourceId: request.id,
      });
      return { request };
    });
  }

  myCreationRequests(context: ActorContext): Promise<ClubCreationRequest[]> {
    return this.db.withActor(context, (tx) => repo.requestsOf(tx, actorPersonId(context)));
  }

  /** The operators' queue (operator context: app.is_platform_operator()). */
  creationRequests(
    context: ActorContext,
    status: ClubCreationRequestStatus,
    page: { cursor?: string | undefined; limit: number },
  ): Promise<{ items: ClubCreationRequest[]; nextCursor: string | null }> {
    return this.db.withActor(context, async (tx) => {
      const result = await repo.requestsPage(tx, status, {
        cursor: page.cursor ?? null,
        limit: page.limit + 1,
      });
      if (!result.cursorFound) throw new DomainError("invalid_cursor");
      const items = result.items.slice(0, page.limit);
      return { items, nextCursor: result.items.length > page.limit ? items.at(-1)!.id : null };
    });
  }

  /** An operator approves (creates the club with the requester as manager) or rejects. */
  async decideCreation(
    context: ActorContext,
    requestId: string,
    decision: { decision: "approve" | "reject"; message?: string | undefined },
  ): Promise<ClubCreationRequest> {
    const me = actorPersonId(context);
    const request = await this.db.withActor(context, (tx) => repo.lockRequest(tx, requestId));
    if (!request) throw new DomainError("not_found");
    if (request.status !== "pending") throw new DomainError("invalid_input");
    const decide = async (tx: Tx, clubId: string | null) => {
      const status: ClubCreationRequestStatus = clubId ? "approved" : "rejected";
      const locked = await repo.lockRequest(tx, requestId);
      if (locked?.status !== "pending") throw new DomainError("invalid_input");
      await repo.decideRequest(tx, requestId, {
        status,
        decidedByPersonId: me,
        decisionMessage: decision.message ?? null,
        createdClubId: clubId,
      });
      await audit.record(tx, {
        action: clubId ? "club.creation.approved" : "club.creation.rejected",
        resourceType: "club_creation_request",
        resourceId: requestId,
        changedFields: ["status", "decided_at", "club_id"],
      });
      await outbox.publish(tx, "club_creation_request.decided", { requestId });
      return {
        ...locked,
        status,
        createdClubId: clubId,
        decidedByPersonId: me,
        decisionMessage: decision.message ?? null,
        decidedAt: new Date(),
      };
    };
    if (decision.decision === "reject") {
      return this.db.withActor(context, (tx) => decide(tx, null));
    }
    const clubContext: TenantContext = { ...context, clubId: uuidv7() };
    return this.db.withTenant(clubContext, async (tx) => {
      await this.createClubInTx(
        tx,
        clubContext,
        {
          name: request.name,
          shortName: request.shortName,
          slug: request.slug,
          country: request.country,
          ...(request.defaultLocale ? { defaultLocale: request.defaultLocale } : {}),
          ...(request.timeZone ? { timeZone: request.timeZone } : {}),
          ...(request.currency ? { currency: request.currency } : {}),
          ...(request.joinPolicy ? { joinPolicy: request.joinPolicy } : {}),
          organizationNumber: request.organizationNumber,
        },
        request.requestedByPersonId,
      );
      return decide(tx, clubContext.clubId);
    });
  }

  // --- Club managers ---------------------------------------------------------

  managers(context: TenantContext): Promise<{ personId: string; validFrom: Date }[]> {
    return this.roles.managers(context);
  }

  /** Appoints an active member as an additional manager. */
  appointManager(context: TenantContext, personId: string): Promise<void> {
    return this.db.withTenant(context, async (tx) => {
      await this.clubs.lockClubInTx(tx, context.clubId);
      if (!(await this.memberships.isMemberInTx(tx, context.clubId, personId))) {
        throw new DomainError("not_a_member");
      }
      await this.roles.assignRoleInTx(tx, context, personId, "club_manager");
      await outbox.publish(tx, "club.manager.changed", {
        clubId: context.clubId,
        personId,
        change: "appointed",
      });
    });
  }

  /** Removes a manager, or the acting manager steps down; never the last one. */
  removeManager(context: TenantContext, personId: string): Promise<void> {
    return this.db.withTenant(context, async (tx) => {
      await this.roles.endManagerInTx(tx, context, personId);
      await outbox.publish(tx, "club.manager.changed", {
        clubId: context.clubId,
        personId,
        change: "removed",
      });
    });
  }

  /** Proposes a successor, who must be an active member (the role moves when they accept). */
  async proposeHandover(context: TenantContext, toPersonId: string): Promise<Handover> {
    const member = await this.db.withTenant(context, (tx) =>
      this.memberships.isMemberInTx(tx, context.clubId, toPersonId),
    );
    if (!member) throw new DomainError("not_a_member");
    return this.roles.proposeHandover(context, toPersonId);
  }

  /** Recovery: the board chair claims the role of a club without managers. */
  claimManager(context: TenantContext): Promise<void> {
    const me = actorPersonId(context);
    return this.db.withTenant(context, async (tx) => {
      await this.roles.recoverManagerInTx(tx, context, me, { by: "chair" });
      await outbox.publish(tx, "club.manager.changed", {
        clubId: context.clubId,
        personId: me,
        change: "claimed",
      });
    });
  }

  /** Recovery: an operator appoints a member on the club's documented request. */
  reassignManager(context: TenantContext, personId: string, reason: string): Promise<void> {
    return this.db.withTenant(context, async (tx) => {
      if (!(await this.memberships.isMemberInTx(tx, context.clubId, personId))) {
        throw new DomainError("not_a_member");
      }
      await this.roles.recoverManagerInTx(tx, context, personId, { by: "operator", reason });
      await outbox.publish(tx, "club.manager.changed", {
        clubId: context.clubId,
        personId,
        change: "reassigned",
      });
    });
  }
}
