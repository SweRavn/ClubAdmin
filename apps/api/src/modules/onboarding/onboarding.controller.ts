// SPDX-License-Identifier: AGPL-3.0-only
// Completing the profile after sign-up and creating clubs (ADR 0018, P1.1).

import {
  type ClubCreationRequestList,
  ClubCreationRequestListSchema,
  ClubCreationRequestQuerySchema,
  type ClubCreationRequestResponse,
  type ClubCreationRequestStatus,
  type CompleteProfileInput,
  CompleteProfileSchema,
  type ConfirmEmailChangeInput,
  ConfirmEmailChangeSchema,
  type CreateClubInput,
  CreateClubRequestSchema,
  type CreateClubResult,
  CreateClubResultSchema,
  type DecisionInput,
  DecisionSchema,
  MyClubCreationRequestsSchema,
  type MyProfile,
  MyProfileSchema,
  type RequestEmailChangeInput,
  RequestEmailChangeSchema,
  RequestParamsSchema,
} from "@clubadmin/shared";
import { Body, Controller, Inject, Param, Query } from "@nestjs/common";

import { API_CONFIG, type ApiConfig, clubCreationMode } from "../../config.ts";
import { DomainError } from "../../platform/domain/domain-error.ts";
import { Endpoint } from "../../platform/http/endpoint.ts";
import { type Account, AccountsService } from "../accounts/index.ts";
import {
  CurrentAuthorization,
  operatorActor,
  PersonPresenter,
  type RequestAuthorization,
} from "../authorization/index.ts";
import { toClubResponse } from "../clubs/index.ts";
import { RecentAuth } from "../identity/index.ts";
import { PeopleService, type Person } from "../people/index.ts";
import { type ClubCreationRequest, OnboardingService } from "./onboarding.service.ts";

function toRequest(request: ClubCreationRequest): ClubCreationRequestResponse {
  return {
    id: request.id,
    status: request.status,
    name: request.name,
    slug: request.slug,
    country: request.country,
    createdAt: request.createdAt.toISOString(),
    decidedAt: request.decidedAt ? request.decidedAt.toISOString() : null,
    decisionMessage: request.decisionMessage,
    clubId: request.createdClubId,
    clubTypeId: request.clubTypeId,
  };
}

/** Email changes: each request sends an email (P2.7d). */
const EMAIL_LIMIT = { max: 5, timeWindowMs: 10 * 60_000 };

@Controller()
export class OnboardingController {
  private readonly onboarding: OnboardingService;
  private readonly people: PeopleService;
  private readonly presenter: PersonPresenter;
  private readonly mode: ReturnType<typeof clubCreationMode>;
  private readonly accounts: AccountsService;

  constructor(
    onboarding: OnboardingService,
    people: PeopleService,
    presenter: PersonPresenter,
    @Inject(API_CONFIG) config: ApiConfig,
    accounts: AccountsService,
  ) {
    this.accounts = accounts;
    this.onboarding = onboarding;
    this.people = people;
    this.presenter = presenter;
    this.mode = clubCreationMode(config);
  }

  @Endpoint({
    method: "GET",
    path: "me/profile",
    summary: "My name and birth date, and whether the profile is complete",
    tags: ["me"],
    access: { authenticated: true },
    response: MyProfileSchema,
  })
  async profile(@CurrentAuthorization() authz: RequestAuthorization): Promise<MyProfile> {
    return this.toProfile(authz, await this.onboarding.myProfile(authz.context));
  }

  @Endpoint({
    method: "PUT",
    path: "me/profile",
    summary: "Complete my profile after sign-up (the birth date is set once)",
    tags: ["me"],
    access: { authenticated: true },
    request: { body: CompleteProfileSchema },
    response: MyProfileSchema,
  })
  async completeProfile(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: CompleteProfileInput,
  ): Promise<MyProfile> {
    return this.toProfile(authz, await this.onboarding.completeProfile(authz.context, body));
  }

  @Endpoint({
    method: "POST",
    path: "me/email",
    summary:
      "Change my login email: a code goes to the new address; nothing changes until it is entered (recent login)",
    tags: ["me"],
    access: { authenticated: true },
    request: { body: RequestEmailChangeSchema },
    response: MyProfileSchema,
    rateLimit: EMAIL_LIMIT,
  })
  @RecentAuth(15)
  async requestEmailChange(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: RequestEmailChangeInput,
  ): Promise<MyProfile> {
    const account = await this.accounts.requestEmailChange(authz.context, body.email);
    return this.toProfile(authz, await this.onboarding.myProfile(authz.context), account);
  }

  @Endpoint({
    method: "POST",
    path: "me/email/confirm",
    summary: "Confirm the new login email with the code sent to it; the old address is told",
    tags: ["me"],
    access: { authenticated: true },
    request: { body: ConfirmEmailChangeSchema },
    response: MyProfileSchema,
    rateLimit: EMAIL_LIMIT,
  })
  async confirmEmailChange(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: ConfirmEmailChangeInput,
  ): Promise<MyProfile> {
    const account = await this.accounts.confirmEmailChange(authz.context, body.code);
    return this.toProfile(authz, await this.onboarding.myProfile(authz.context), account);
  }

  @Endpoint({
    method: "DELETE",
    path: "me/email/pending",
    summary: "Drop an open change of my login email",
    tags: ["me"],
    access: { authenticated: true },
    response: MyProfileSchema,
  })
  async cancelEmailChange(@CurrentAuthorization() authz: RequestAuthorization): Promise<MyProfile> {
    const account = await this.accounts.cancelEmailChange(authz.context);
    return this.toProfile(authz, await this.onboarding.myProfile(authz.context), account);
  }

  @Endpoint({
    method: "POST",
    path: "clubs",
    summary: "Create a club and become its manager, or ask an operator to (CLUB_CREATION=approval)",
    tags: ["clubs"],
    access: { permission: "club.create", resource: "platform" },
    request: { body: CreateClubRequestSchema },
    response: CreateClubResultSchema,
    accountLimit: "joining",
  })
  async create(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: CreateClubInput,
  ): Promise<CreateClubResult> {
    const operator = authz.actor.isOperator() && authz.actor.mfa;
    const result = await this.onboarding.createOrRequest(authz.context, body, {
      mode: this.mode,
      operator,
    });
    return "club" in result
      ? { outcome: "created", club: toClubResponse(result.club) }
      : { outcome: "requested", request: toRequest(result.request) };
  }

  @Endpoint({
    method: "GET",
    path: "me/club-creation-requests",
    summary: "My requests to create a club",
    tags: ["me", "clubs"],
    access: { authenticated: true },
    response: MyClubCreationRequestsSchema,
  })
  async myRequests(
    @CurrentAuthorization() authz: RequestAuthorization,
  ): Promise<{ items: ClubCreationRequestResponse[] }> {
    return { items: (await this.onboarding.myCreationRequests(authz.context)).map(toRequest) };
  }

  @Endpoint({
    method: "GET",
    path: "ops/club-creation-requests",
    summary: "Requests to create a club (operators), oldest first",
    tags: ["ops"],
    access: { permission: "club.creation.decide", resource: "platform" },
    request: { query: ClubCreationRequestQuerySchema },
    response: ClubCreationRequestListSchema,
  })
  async requests(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: { status: ClubCreationRequestStatus; cursor?: string; limit: number },
  ): Promise<ClubCreationRequestList> {
    const context = operatorActor(authz.context);
    const page = await this.onboarding.creationRequests(context, query.status, query);
    // The requesters have no club yet: operators see their names to decide.
    const requesters = await this.people.requesterSummaries(
      page.items.map((r) => r.requestedByPersonId),
    );
    const shown = new Map(
      (await this.presenter.present(authz, null, requesters)).map((p) => [p.id, p]),
    );
    return {
      items: page.items.map((r) => ({
        ...toRequest(r),
        requestedBy: shown.get(r.requestedByPersonId) ?? null,
      })),
      nextCursor: page.nextCursor,
    };
  }

  @Endpoint({
    method: "POST",
    path: "ops/club-creation-requests/:requestId/decision",
    summary: "Approve (creates the club with the requester as manager) or reject a request",
    tags: ["ops"],
    access: { permission: "club.creation.decide", resource: "platform" },
    request: { params: RequestParamsSchema, body: DecisionSchema },
    response: MyClubCreationRequestsSchema,
    status: 200,
  })
  async decide(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param("requestId") requestId: string,
    @Body() body: DecisionInput,
  ): Promise<{ items: ClubCreationRequestResponse[] }> {
    const request = await this.onboarding.decideCreation(
      operatorActor(authz.context),
      requestId,
      body,
    );
    return { items: [toRequest(request)] };
  }

  private async toProfile(
    authz: RequestAuthorization,
    person: Person,
    /** The account when the caller already has it (else read here; null without a login). */
    known?: Account | null,
  ): Promise<MyProfile> {
    // One transaction at a time per request (ADR 0040).
    const summary = await this.presenter.presentOne(authz, null, person);
    const account = known === undefined ? await this.accounts.getOwnAccount(authz.context) : known;
    if (!summary) throw new DomainError("not_found");
    const operator = authz.actor.isOperator();
    const clubCreation =
      this.mode === "open" || operator
        ? "create"
        : this.mode === "approval"
          ? "request"
          : "not_allowed";
    return {
      person: summary,
      birthDate: person.birthDate,
      complete: person.birthDate !== null,
      clubCreation,
      // P2.7d: one's own contact details and login email (ADR 0057).
      phone: person.phone,
      address: person.address,
      protectedIdentity: person.protectedIdentity,
      email: account?.email ?? null,
      pendingEmail:
        account?.pendingEmail && account.pendingEmailExpiresAt
          ? { email: account.pendingEmail, expiresAt: account.pendingEmailExpiresAt.toISOString() }
          : null,
    };
  }
}
