// SPDX-License-Identifier: AGPL-3.0-only
// Authorization and person visibility end to end through the HTTP API, on
// the "matrix" scenario (testing/scenarios.ts): the permission matrix for
// every permission endpoint, tenant isolation, protected identity, guardians
// acting on behalf of a ward, cache invalidation and the performance budgets.

import {
  authorizationCacheHandler,
  type CacheVersions,
  outbox,
  type OutboxHandler,
  sql,
} from "@clubadmin/db";
import { countQueries, createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import {
  ON_BEHALF_OF_HEADER,
  PersonParamsSchema,
  relationshipSetKey,
  uuidv7,
  z,
} from "@clubadmin/shared";
import { Body, Controller, Module } from "@nestjs/common";
import type { InjectOptions } from "fastify";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Endpoint } from "../../platform/http/endpoint.ts";
import { EndpointRegistry } from "../../platform/http/endpoint-registry.ts";
import { actor, buildPerson } from "../../testing/builders.ts";
import { auditActionsOf } from "../../testing/core.ts";
import { devToken, TEST_DEV_AUTH_KEY } from "../../testing/oidc.ts";
import {
  buildMatrixScenario,
  grantSupportAccess,
  MATRIX_PERSONAS,
  type MatrixPersona,
  type MatrixScenario,
} from "../../testing/scenarios.ts";
import { type CoreServices, createCoreServices } from "../../testing/services.ts";
import { createTestApp, NO_RATE_LIMITS, type TestApp } from "../../testing/test-app.ts";
import { PeopleModule, PeopleService } from "../people/index.ts";
import { AuthorizationService } from "./authorization.service.ts";
import { PersonPresenter } from "./presenters/person.presenter.ts";
import {
  CurrentAuthorization,
  type RequestAuthorization,
  resourceOf,
} from "./request-authorization.ts";

const PhoneBody = z.object({ phone: z.string() });

/** A write endpoint for the on-behalf-of test (write endpoints come with P1.x). */
@Controller("test-authz")
class OnBehalfController {
  private readonly people: PeopleService;

  constructor(people: PeopleService) {
    this.people = people;
  }

  @Endpoint({
    method: "POST",
    path: "people/:personId/phone",
    summary: "Test: update a phone number",
    access: { permission: "person.profile.update", resource: "person" },
    request: { params: PersonParamsSchema, body: PhoneBody },
    response: z.object({ ok: z.boolean() }),
    status: 200,
  })
  async update(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: z.infer<typeof PhoneBody>,
  ): Promise<{ ok: boolean }> {
    const { personId } = resourceOf(authz, "person");
    await this.people.updateProfile(authz.context, personId, { phone: body.phone });
    return { ok: true };
  }
}

@Module({ imports: [PeopleModule], controllers: [OnBehalfController] })
class OnBehalfModule {}

const VALKEY_URL = process.env.VALKEY_URL ?? "redis://127.0.0.1:6379";

let t: TestDatabase;
let s: CoreServices;
let app: TestApp;
let valkey: Redis;
let m: MatrixScenario;
let cacheHandler: OutboxHandler;

beforeAll(async () => {
  t = await createTestDatabase();
  s = createCoreServices(t.db);
  valkey = new Redis(VALKEY_URL, { lazyConnect: true });
  await valkey.connect();
  const versions: CacheVersions = {
    bump: async (keys) => {
      for (const key of keys) await valkey.incr(key);
    },
  };
  cacheHandler = authorizationCacheHandler(versions);
  app = await createTestApp(
    {
      NODE_ENV: "development",
      DATABASE_URL: t.url("app"),
      VALKEY_URL,
      DEV_AUTH: "true",
      DEV_AUTH_KEY: TEST_DEV_AUTH_KEY,
      // The matrix and the benchmark send many requests from one address.
      ...NO_RATE_LIMITS,
    },
    [OnBehalfModule],
  );
  m = await buildMatrixScenario(s, t);
  await dispatchPending();
});
afterAll(async () => {
  await app?.close();
  valkey?.disconnect();
  await t?.drop();
});

/** Runs the outbox handlers for all pending events, as the worker would. */
async function dispatchPending(): Promise<void> {
  const { rows } = await t.query<{ id: string }>(
    "admin",
    "SELECT id FROM outbox.events WHERE status <> 'done' ORDER BY created_at, id",
  );
  for (const { id } of rows) await outbox.dispatch(t.db, id, [cacheHandler]);
}

const inject = (options: InjectOptions) => app.app.getHttpAdapter().getInstance().inject(options);

async function get(
  personId: string,
  url: string,
  options: { mfa?: boolean; headers?: Record<string, string> } = {},
) {
  const token = await devToken(personId, { mfa: options.mfa ?? false });
  return inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${token}`, ...options.headers },
  });
}

const personaId = (persona: MatrixPersona): string => m[persona].id;

describe("permission matrix", () => {
  const ALL_OK = Object.fromEntries(MATRIX_PERSONAS.map((p) => [p, 200])) as Record<
    MatrixPersona,
    number
  >;
  const INSIDERS = { ...ALL_OK, outsider: 404, operator: 404 };
  const ROSTER = { ...INSIDERS, relative: 403 };
  const PROFILE = { ...INSIDERS, relative: 404 };

  // Operator-only endpoints with a second factor: these tokens have none, so
  // the operator gets 403 (mfa-required), people of the club 403, others 404.
  const OPERATOR_CLUB = {
    ...Object.fromEntries(MATRIX_PERSONAS.map((p) => [p, 403])),
    outsider: 404,
  } as Record<MatrixPersona, number>;
  const ALL_FORBIDDEN = Object.fromEntries(MATRIX_PERSONAS.map((p) => [p, 403])) as Record<
    MatrixPersona,
    number
  >;
  const ALL_NOT_FOUND = Object.fromEntries(MATRIX_PERSONAS.map((p) => [p, 404])) as Record<
    MatrixPersona,
    number
  >;
  // Club insiders without the permission: 403; outsiders and the operator (no grant): 404.
  const CLUB_FORBIDDEN = { ...ALL_FORBIDDEN, outsider: 404, operator: 404 };
  /** Managers and registrars get `status`, other insiders 403. */
  const ADMINS = (status: number) => ({ ...CLUB_FORBIDDEN, manager: status, registrar: status });
  /** Those who manage team T's activities get `status`, other insiders 403. */
  const TEAM_MANAGERS = (status: number) => ({
    ...CLUB_FORBIDDEN,
    manager: status,
    owner: status,
    coach: status,
  });
  const RANGE = `from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(
    new Date(Date.now() + 120 * 86_400_000).toISOString(),
  )}`;

  /**
   * Every endpoint with a permission (and the own-data reads) must be listed
   * here. Billing endpoints are tested when the app has them (BILLING_ENABLED).
   */
  const MATRIX: Record<
    string,
    {
      url: () => string;
      expected: Record<MatrixPersona, number>;
      /** A function when it needs the scenario (built in beforeAll). */
      body?: Record<string, unknown> | (() => Record<string, unknown>);
    }
  > = {
    "GET /api/v1/me/clubs": { url: () => "/api/v1/me/clubs", expected: ALL_OK },
    "GET /api/v1/me/wards": { url: () => "/api/v1/me/wards", expected: ALL_OK },
    "GET /api/v1/me/groups": { url: () => "/api/v1/me/groups", expected: ALL_OK },
    "GET /api/v1/clubs/:clubId": { url: () => `/api/v1/clubs/${m.clubA.id}`, expected: INSIDERS },
    "GET /api/v1/clubs/:clubId/groups": {
      url: () => `/api/v1/clubs/${m.clubA.id}/groups`,
      expected: INSIDERS,
    },
    "GET /api/v1/groups/:groupId": { url: () => `/api/v1/groups/${m.team.id}`, expected: INSIDERS },
    "GET /api/v1/groups/:groupId/members": {
      url: () => `/api/v1/groups/${m.team.id}/members`,
      expected: ROSTER,
    },
    "GET /api/v1/people/:personId": {
      url: () => `/api/v1/people/${m.child.id}?clubId=${m.clubA.id}`,
      expected: PROFILE,
    },
    // Operators only, with a second factor (these tokens have none): see backups.integration.test.ts.
    "GET /api/v1/ops/backup-status": {
      url: () => "/api/v1/ops/backup-status",
      expected: Object.fromEntries(MATRIX_PERSONAS.map((p) => [p, 403])) as Record<
        MatrixPersona,
        number
      >,
    },
    "GET /api/v1/clubs/:clubId/entitlements": {
      url: () => `/api/v1/clubs/${m.clubA.id}/entitlements`,
      expected: INSIDERS,
    },
    "PUT /api/v1/clubs/:clubId/access-state": {
      url: () => `/api/v1/clubs/${m.clubA.id}/access-state`,
      expected: OPERATOR_CLUB,
      body: { accessState: "active" },
    },
    "GET /api/v1/billing/plans": { url: () => "/api/v1/billing/plans", expected: ALL_FORBIDDEN },
    "GET /api/v1/clubs/:clubId/subscription": {
      url: () => `/api/v1/clubs/${m.clubA.id}/subscription`,
      // Club managers (and treasurers) read it; the operator needs a second factor.
      expected: { ...OPERATOR_CLUB, manager: 200 },
    },
    "PUT /api/v1/clubs/:clubId/subscription": {
      url: () => `/api/v1/clubs/${m.clubA.id}/subscription`,
      expected: OPERATOR_CLUB,
      body: { planKey: "standard" },
    },
    "PUT /api/v1/clubs/:clubId/subscription/status": {
      url: () => `/api/v1/clubs/${m.clubA.id}/subscription/status`,
      expected: OPERATOR_CLUB,
      body: { status: "active" },
    },
    // Joining (P1.1). Writes aimed at IDs that do not exist: allowed callers
    // get the service's 404, the others the policy's 403 (or 404 outside the
    // club). The flows themselves: joining.integration.test.ts.
    "POST /api/v1/clubs": {
      url: () => "/api/v1/clubs",
      // CLUB_CREATION defaults to operators_only when self-hosted; the operator needs MFA.
      expected: ALL_FORBIDDEN,
      body: { name: "Matrix IF", slug: "matrix-if", country: "SE" },
    },
    "GET /api/v1/ops/club-creation-requests": {
      url: () => "/api/v1/ops/club-creation-requests",
      expected: ALL_FORBIDDEN,
    },
    "POST /api/v1/ops/club-creation-requests/:requestId/decision": {
      url: () => `/api/v1/ops/club-creation-requests/${uuidv7()}/decision`,
      expected: ALL_FORBIDDEN,
      body: { decision: "reject" },
    },
    "GET /api/v1/clubs/:clubId/join-requests": {
      url: () => `/api/v1/clubs/${m.clubA.id}/join-requests`,
      expected: ADMINS(200),
    },
    "POST /api/v1/clubs/:clubId/join-requests/:joinRequestId/decision": {
      url: () => `/api/v1/clubs/${m.clubA.id}/join-requests/${uuidv7()}/decision`,
      expected: ADMINS(404),
      body: { decision: "reject" },
    },
    "GET /api/v1/clubs/:clubId/invitations": {
      url: () => `/api/v1/clubs/${m.clubA.id}/invitations`,
      expected: ADMINS(200),
    },
    "POST /api/v1/clubs/:clubId/invitations": {
      url: () => `/api/v1/clubs/${m.clubA.id}/invitations`,
      expected: ADMINS(201),
      body: { kind: "link" },
    },
    "POST /api/v1/clubs/:clubId/invitations/:invitationId/revoke": {
      url: () => `/api/v1/clubs/${m.clubA.id}/invitations/${uuidv7()}/revoke`,
      expected: ADMINS(404),
    },
    "GET /api/v1/clubs/:clubId/managers": {
      url: () => `/api/v1/clubs/${m.clubA.id}/managers`,
      expected: INSIDERS,
    },
    // club.roles.manage needs a second factor: even the manager gets 403 here.
    "POST /api/v1/clubs/:clubId/managers": {
      url: () => `/api/v1/clubs/${m.clubA.id}/managers`,
      expected: CLUB_FORBIDDEN,
      body: { personId: uuidv7() },
    },
    "DELETE /api/v1/clubs/:clubId/managers/:personId": {
      url: () => `/api/v1/clubs/${m.clubA.id}/managers/${uuidv7()}`,
      expected: CLUB_FORBIDDEN,
    },
    "POST /api/v1/clubs/:clubId/manager-handovers": {
      url: () => `/api/v1/clubs/${m.clubA.id}/manager-handovers`,
      expected: CLUB_FORBIDDEN,
      body: { toPersonId: uuidv7() },
    },
    // Only a board chair (none in the scenario), with a second factor.
    "POST /api/v1/clubs/:clubId/managers/claim": {
      url: () => `/api/v1/clubs/${m.clubA.id}/managers/claim`,
      expected: CLUB_FORBIDDEN,
    },
    "POST /api/v1/ops/clubs/:clubId/managers": {
      url: () => `/api/v1/ops/clubs/${m.clubA.id}/managers`,
      expected: OPERATOR_CLUB,
      body: { personId: uuidv7(), reason: "Board minutes 2026-10-01" },
    },
    // A hand-over exists only for its two parties: everyone else gets 404.
    "POST /api/v1/manager-handovers/:handoverId/accept": {
      url: () => `/api/v1/manager-handovers/${uuidv7()}/accept`,
      expected: ALL_NOT_FOUND,
    },
    "POST /api/v1/manager-handovers/:handoverId/decline": {
      url: () => `/api/v1/manager-handovers/${uuidv7()}/decline`,
      expected: ALL_NOT_FOUND,
    },
    "POST /api/v1/manager-handovers/:handoverId/cancel": {
      url: () => `/api/v1/manager-handovers/${uuidv7()}/cancel`,
      expected: ALL_NOT_FOUND,
    },
    // Member register (P1.2): the flows are in members.integration.test.ts.
    "GET /api/v1/clubs/:clubId/members": {
      url: () => `/api/v1/clubs/${m.clubA.id}/members`,
      expected: ADMINS(200),
    },
    "GET /api/v1/clubs/:clubId/members/facets": {
      url: () => `/api/v1/clubs/${m.clubA.id}/members/facets`,
      expected: ADMINS(200),
    },
    // Registrars without a second factor; club managers need one (403 here).
    "PATCH /api/v1/clubs/:clubId/members/:personId/membership": {
      url: () => `/api/v1/clubs/${m.clubA.id}/members/${uuidv7()}/membership`,
      expected: { ...CLUB_FORBIDDEN, registrar: 404 },
      body: { status: "paused" },
    },
    // Exports need a second factor: 403 for everyone in the club here.
    "POST /api/v1/clubs/:clubId/member-exports": {
      url: () => `/api/v1/clubs/${m.clubA.id}/member-exports`,
      expected: CLUB_FORBIDDEN,
      body: { columns: ["name"] },
    },
    "GET /api/v1/clubs/:clubId/member-exports": {
      url: () => `/api/v1/clubs/${m.clubA.id}/member-exports`,
      expected: CLUB_FORBIDDEN,
    },
    "GET /api/v1/clubs/:clubId/member-exports/:exportId/download": {
      url: () => `/api/v1/clubs/${m.clubA.id}/member-exports/${uuidv7()}/download`,
      expected: CLUB_FORBIDDEN,
    },
    // Adding members by hand (P1.3b): registrars without a second factor,
    // club managers with one (403 here). The flows: member-intake.integration.test.ts.
    "POST /api/v1/clubs/:clubId/members": {
      url: () => `/api/v1/clubs/${m.clubA.id}/members`,
      expected: { ...CLUB_FORBIDDEN, registrar: 201 },
      body: { givenName: "Matrix", familyName: "Member", birthDate: "1990-01-01" },
    },
    // Imports always need a second factor: 403 for everyone in the club here.
    ...Object.fromEntries(
      (
        [
          ["POST", "", { size: 100 }],
          ["GET", "", undefined],
          ["POST", "/:importId/uploaded", undefined],
          ["GET", "/:importId", undefined],
          ["PUT", "/:importId/mapping", { columnMap: {}, options: {} }],
          ["GET", "/:importId/rows", undefined],
          ["PATCH", "/:importId/rows/:rowNumber", { action: "skip" }],
          ["POST", "/:importId/confirm", undefined],
          ["POST", "/:importId/cancel", undefined],
        ] as const
      ).map(([method, path, body]) => [
        `${method} /api/v1/clubs/:clubId/member-imports${path}`,
        {
          url: () =>
            `/api/v1/clubs/${m.clubA.id}/member-imports${path
              .replace(":importId", uuidv7())
              .replace(":rowNumber", "1")}`,
          expected: CLUB_FORBIDDEN,
          ...(body ? { body } : {}),
        },
      ]),
    ),
    // Families (P1.3): the flows are in families.integration.test.ts. People
    // and family resources the caller cannot reach are 404 (their existence
    // is information).
    "GET /api/v1/me/wards/:personId/guardians": {
      url: () => `/api/v1/me/wards/${m.child.id}/guardians`,
      expected: { ...ALL_NOT_FOUND, parent: 200, relative: 200 },
    },
    "POST /api/v1/me/wards/:personId/guardian-invitations": {
      url: () => `/api/v1/me/wards/${m.sibling.id}/guardian-invitations`,
      expected: { ...ALL_NOT_FOUND, parent: 201 },
      body: { email: "matrix-aunt@example.test", kind: "relative" },
    },
    "POST /api/v1/me/wards/:personId/guardians": {
      url: () => `/api/v1/me/wards/${m.sibling.id}/guardians`,
      expected: { ...ALL_NOT_FOUND, parent: 201 },
      body: { person: { givenName: "Matrix", familyName: "Neighbour" }, kind: "contact_person" },
    },
    "POST /api/v1/guardian-invitations/:invitationId/resend": {
      url: () => `/api/v1/guardian-invitations/${uuidv7()}/resend`,
      expected: ALL_NOT_FOUND,
    },
    "POST /api/v1/guardian-invitations/:invitationId/revoke": {
      url: () => `/api/v1/guardian-invitations/${uuidv7()}/revoke`,
      expected: ALL_NOT_FOUND,
    },
    "PATCH /api/v1/guardianships/:guardianshipId": {
      url: () => `/api/v1/guardianships/${m.relativeGuardianshipId}`,
      expected: { ...ALL_NOT_FOUND, parent: 200 },
      body: { rights: ["view_schedule"] },
    },
    // A merge of a person with a login is refused (409); club managers need a second factor.
    "POST /api/v1/people/:personId/merge": {
      url: () => `/api/v1/people/${m.child.id}/merge?clubId=${m.clubA.id}`,
      expected: { ...ALL_NOT_FOUND, parent: 409, manager: 403 },
      body: () => ({ duplicatePersonId: m.member.id }),
    },
    "POST /api/v1/people/merges/:mergeId/undo": {
      url: () => `/api/v1/people/merges/${uuidv7()}/undo`,
      expected: ALL_NOT_FOUND,
    },
    // The child is below the own-login age (409 for everyone allowed).
    "POST /api/v1/people/:personId/own-login-invitations": {
      url: () => `/api/v1/people/${m.child.id}/own-login-invitations?clubId=${m.clubA.id}`,
      expected: { ...ALL_NOT_FOUND, parent: 409, manager: 409, registrar: 409 },
      body: { email: "liv@example.test" },
    },
    "GET /api/v1/clubs/:clubId/members/:personId/guardians": {
      url: () => `/api/v1/clubs/${m.clubA.id}/members/${m.child.id}/guardians`,
      expected: ADMINS(200),
    },
    "POST /api/v1/clubs/:clubId/members/:personId/guardians": {
      url: () => `/api/v1/clubs/${m.clubA.id}/members/${m.sibling.id}/guardians`,
      expected: ADMINS(201),
      body: {
        guardian: { person: { givenName: "Paper", familyName: "Form" } },
        kind: "contact_person",
        consentNote: "Signed form on file",
      },
    },
    "POST /api/v1/clubs/:clubId/guardianships/:guardianshipId/end": {
      url: () => `/api/v1/clubs/${m.clubA.id}/guardianships/${uuidv7()}/end`,
      expected: ADMINS(404),
      body: {},
    },
    "GET /api/v1/clubs/:clubId/duplicates": {
      url: () => `/api/v1/clubs/${m.clubA.id}/duplicates`,
      expected: ADMINS(200),
    },
    // Activities (P1.4): the flows are in activities.integration.test.ts.
    // Readers of team T's activities: everyone in club A related to the team
    // (the relative through view_schedule); managers: the club manager, the
    // owner of its section and its head coach. Requests run in persona order,
    // so after the manager's write the others see its result (409, 404).
    "GET /api/v1/clubs/:clubId/locations": {
      url: () => `/api/v1/clubs/${m.clubA.id}/locations`,
      expected: INSIDERS,
    },
    "POST /api/v1/clubs/:clubId/locations": {
      url: () => `/api/v1/clubs/${m.clubA.id}/locations`,
      expected: { ...CLUB_FORBIDDEN, manager: 201 },
      body: { name: "Matrix pitch" },
    },
    "PATCH /api/v1/clubs/:clubId/locations/:locationId": {
      url: () => `/api/v1/clubs/${m.clubA.id}/locations/${m.locationId}`,
      expected: { ...CLUB_FORBIDDEN, manager: 200 },
      body: { directions: "Entrance B" },
    },
    "GET /api/v1/clubs/:clubId/locations/:locationId/conflicts": {
      url: () => `/api/v1/clubs/${m.clubA.id}/locations/${m.locationId}/conflicts?${RANGE}`,
      expected: ADMINS(200),
    },
    "GET /api/v1/clubs/:clubId/activities": {
      url: () => `/api/v1/clubs/${m.clubA.id}/activities?${RANGE}`,
      expected: ADMINS(200),
    },
    "GET /api/v1/groups/:groupId/activities": {
      url: () => `/api/v1/groups/${m.team.id}/activities?${RANGE}`,
      expected: INSIDERS,
    },
    "POST /api/v1/groups/:groupId/activities": {
      url: () => `/api/v1/groups/${m.team.id}/activities`,
      expected: TEAM_MANAGERS(201),
      body: {
        kind: "match",
        title: "Matrix cup",
        startsAt: "2027-01-10T10:00:00Z",
        endsAt: "2027-01-10T12:00:00Z",
      },
    },
    "POST /api/v1/groups/:groupId/activity-series/preview": {
      url: () => `/api/v1/groups/${m.team.id}/activity-series/preview`,
      expected: TEAM_MANAGERS(200),
      body: {
        slots: [{ weekday: 1, startTime: "17:30", durationMinutes: 60 }],
        startsOn: "2027-01-01",
        endsOn: "2027-02-28",
      },
    },
    "POST /api/v1/groups/:groupId/activity-series": {
      url: () => `/api/v1/groups/${m.team.id}/activity-series`,
      expected: TEAM_MANAGERS(201),
      body: {
        title: "Matrix futsal",
        slots: [{ weekday: 5, startTime: "19:00", durationMinutes: 60 }],
        startsOn: "2027-01-01",
        endsOn: "2027-01-31",
      },
    },
    "GET /api/v1/activities/:activityId": {
      url: () => `/api/v1/activities/${m.activityId}`,
      expected: INSIDERS,
    },
    "PATCH /api/v1/activities/:activityId": {
      url: () => `/api/v1/activities/${m.activityId}`,
      expected: TEAM_MANAGERS(200),
      body: { opponent: "Matrix BK" },
    },
    "POST /api/v1/activities/:activityId/cancel": {
      url: () => `/api/v1/activities/${m.activityId}/cancel`,
      expected: { ...TEAM_MANAGERS(409), manager: 200 },
      body: { reason: "Pitch frozen" },
    },
    "POST /api/v1/activities/:activityId/restore": {
      url: () => `/api/v1/activities/${m.activityId}/restore`,
      expected: { ...TEAM_MANAGERS(409), manager: 200 },
      body: {},
    },
    "DELETE /api/v1/activities/:activityId": {
      url: () => `/api/v1/activities/${m.disposableActivityId}`,
      // The manager deletes it; for everyone after that it no longer exists.
      expected: { ...ALL_NOT_FOUND, manager: 204 },
    },
    "GET /api/v1/activity-series/:seriesId": {
      url: () => `/api/v1/activity-series/${m.seriesId}`,
      expected: INSIDERS,
    },
    "PATCH /api/v1/activity-series/:seriesId": {
      url: () => `/api/v1/activity-series/${m.seriesId}`,
      expected: TEAM_MANAGERS(200),
      body: { notes: "Bring water" },
    },
    "POST /api/v1/activity-series/:seriesId/split": {
      url: () => `/api/v1/activity-series/${m.seriesId}/split`,
      // After the manager's split the session belongs to the new series.
      expected: { ...TEAM_MANAGERS(409), manager: 201 },
      body: () => ({ activityId: m.laterSessionId, title: "Matrix training (spring)" }),
    },
    "GET /api/v1/me/schedule": { url: () => `/api/v1/me/schedule?${RANGE}`, expected: ALL_OK },
    // Responses and attendance (P1.5): the flows are in attendance.integration.test.ts.
    // Only the parent answers for the child (the member may answer only for
    // themselves: 404); leaders see the answers and take attendance (the
    // match is ahead: 409 activity_not_started), registrars too.
    "PUT /api/v1/activities/:activityId/responses/:personId": {
      url: () => `/api/v1/activities/${m.activityId}/responses/${m.child.id}`,
      expected: { ...CLUB_FORBIDDEN, member: 404, parent: 200 },
      body: { status: "attending" },
    },
    "DELETE /api/v1/activities/:activityId/responses/:personId": {
      url: () => `/api/v1/activities/${m.activityId}/responses/${m.child.id}`,
      expected: { ...CLUB_FORBIDDEN, member: 404, parent: 200 },
    },
    "GET /api/v1/activities/:activityId/responses/summary": {
      url: () => `/api/v1/activities/${m.activityId}/responses/summary`,
      expected: INSIDERS,
    },
    "GET /api/v1/activities/:activityId/responses": {
      url: () => `/api/v1/activities/${m.activityId}/responses`,
      expected: TEAM_MANAGERS(200),
    },
    // Call-ups (#19): leaders see them, those who manage the activity set them
    // (the whole group again here, which changes nothing).
    "GET /api/v1/activities/:activityId/invitees": {
      url: () => `/api/v1/activities/${m.activityId}/invitees`,
      expected: TEAM_MANAGERS(200),
    },
    "PUT /api/v1/activities/:activityId/invitees": {
      url: () => `/api/v1/activities/${m.activityId}/invitees`,
      expected: TEAM_MANAGERS(200),
      body: { inviteesOnly: false, personIds: [] },
    },
    "GET /api/v1/activities/:activityId/attendance": {
      url: () => `/api/v1/activities/${m.activityId}/attendance`,
      expected: { ...TEAM_MANAGERS(200), registrar: 200 },
    },
    "PUT /api/v1/activities/:activityId/attendance": {
      url: () => `/api/v1/activities/${m.activityId}/attendance`,
      expected: { ...TEAM_MANAGERS(409), registrar: 409 },
      body: () => ({ marks: [{ personId: m.member.id, status: "present" }] }),
    },
    "GET /api/v1/groups/:groupId/attendance": {
      url: () => `/api/v1/groups/${m.team.id}/attendance?${RANGE}`,
      expected: { ...TEAM_MANAGERS(200), registrar: 200 },
    },
    // Events with sign-up (P1.6): the flows are in events.integration.test.ts.
    "GET /api/v1/clubs/:clubId/events": {
      url: () => `/api/v1/clubs/${m.clubA.id}/events`,
      expected: INSIDERS,
    },
    "GET /api/v1/groups/:groupId/events": {
      url: () => `/api/v1/groups/${m.team.id}/events`,
      expected: INSIDERS,
    },
    "POST /api/v1/clubs/:clubId/events": {
      url: () => `/api/v1/clubs/${m.clubA.id}/events`,
      expected: TEAM_MANAGERS(201),
      body: () => ({
        title: "Matrix tournament",
        audience: "groups",
        groupIds: [m.team.id],
        startsAt: "2027-05-01T08:00:00Z",
        endsAt: "2027-05-01T16:00:00Z",
        registrationClosesAt: "2027-04-25T20:00:00Z",
      }),
    },
    "GET /api/v1/events/:eventId": {
      url: () => `/api/v1/events/${m.eventId}`,
      expected: INSIDERS,
    },
    "PATCH /api/v1/events/:eventId": {
      url: () => `/api/v1/events/${m.eventId}`,
      expected: TEAM_MANAGERS(200),
      body: { priceText: "100 kr" },
    },
    "POST /api/v1/events/:eventId/publish": {
      url: () => `/api/v1/events/${m.eventId}/publish`,
      expected: TEAM_MANAGERS(409),
      body: {},
    },
    "POST /api/v1/events/:eventId/cancel": {
      url: () => `/api/v1/events/${m.cancelEventId}/cancel`,
      expected: { ...TEAM_MANAGERS(409), manager: 200 },
      body: { reason: "Too few teams" },
    },
    "DELETE /api/v1/events/:eventId": {
      url: () => `/api/v1/events/${m.draftEventId}`,
      // The manager deletes the draft; for everyone after that it no longer exists.
      expected: { ...ALL_NOT_FOUND, manager: 204 },
    },
    "PUT /api/v1/events/:eventId/activities": {
      url: () => `/api/v1/events/${m.eventId}/activities`,
      expected: TEAM_MANAGERS(200),
      body: { activityIds: [] },
    },
    // Only the parent signs up the child (the member only themselves: 404).
    "PUT /api/v1/events/:eventId/registrations/:personId": {
      url: () => `/api/v1/events/${m.eventId}/registrations/${m.child.id}`,
      expected: { ...CLUB_FORBIDDEN, member: 404, parent: 200 },
      body: { answers: {} },
    },
    "GET /api/v1/events/:eventId/registrations": {
      url: () => `/api/v1/events/${m.eventId}/registrations`,
      expected: { ...TEAM_MANAGERS(200), registrar: 200 },
    },
    "GET /api/v1/events/:eventId/registrations.csv": {
      url: () => `/api/v1/events/${m.eventId}/registrations.csv`,
      expected: { ...TEAM_MANAGERS(200), registrar: 200 },
    },
    "DELETE /api/v1/events/:eventId/registrations/:personId": {
      url: () => `/api/v1/events/${m.eventId}/registrations/${m.child.id}`,
      expected: { ...CLUB_FORBIDDEN, member: 404, parent: 200 },
    },
    // No offer and no open registration any more: 409 for those allowed.
    "POST /api/v1/events/:eventId/registrations/:personId/accept": {
      url: () => `/api/v1/events/${m.eventId}/registrations/${m.child.id}/accept`,
      expected: { ...CLUB_FORBIDDEN, member: 404, parent: 409 },
      body: {},
    },
    "POST /api/v1/events/:eventId/registrations/:personId/decline": {
      url: () => `/api/v1/events/${m.eventId}/registrations/${m.child.id}/decline`,
      expected: { ...CLUB_FORBIDDEN, member: 404, parent: 409 },
      body: {},
    },
    "POST /api/v1/events/:eventId/registrations/:personId/confirm": {
      url: () => `/api/v1/events/${m.eventId}/registrations/${m.child.id}/confirm`,
      expected: TEAM_MANAGERS(409),
      body: { reason: "Goalkeeper needed" },
    },
    "POST /api/v1/events/:eventId/registrations/:personId/remove": {
      url: () => `/api/v1/events/${m.eventId}/registrations/${m.child.id}/remove`,
      expected: TEAM_MANAGERS(409),
      body: { reason: "Duplicate" },
    },
    "GET /api/v1/me/events": { url: () => "/api/v1/me/events", expected: ALL_OK },
    "POST /api/v1/test-authz/people/:personId/phone": {
      url: () => `/api/v1/test-authz/people/${m.child.id}/phone`,
      expected: {
        ...Object.fromEntries(MATRIX_PERSONAS.map((p) => [p, 404])),
        parent: 200,
      } as Record<MatrixPersona, number>,
    },
  };

  it("covers every endpoint that has a permission", () => {
    const endpoints = app.app
      .get(EndpointRegistry)
      .all()
      .filter((e) => "permission" in e.access)
      .map((e) => `${e.method} ${e.fullPath}`);
    expect(endpoints.filter((e) => !(e in MATRIX))).toEqual([]);
  });

  for (const [endpoint, { url, expected, body: bodyOf }] of Object.entries(MATRIX)) {
    it(endpoint, async (test) => {
      const body = typeof bodyOf === "function" ? bodyOf() : bodyOf;
      const registered = app.app
        .get(EndpointRegistry)
        .all()
        .some((e) => `${e.method} ${e.fullPath}` === endpoint);
      // Billing routes exist only with BILLING_ENABLED=true (CI runs both).
      if (!registered && /\/(billing|subscription)/.test(endpoint)) test.skip();
      const actual: Record<string, number> = {};
      for (const persona of MATRIX_PERSONAS) {
        const token = await devToken(personaId(persona));
        const method = endpoint.split(" ")[0] as "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
        const res = await inject({
          method,
          url: url(),
          headers: { authorization: `Bearer ${token}` },
          ...(method === "POST" ? { payload: body ?? { phone: "+46 70 000 00 00" } } : {}),
          ...(method === "PUT" || method === "PATCH" ? { payload: body ?? {} } : {}),
        });
        actual[persona] = res.statusCode;
      }
      expect(actual).toEqual(expected);
    });
  }
});

describe("tenant isolation", () => {
  it("answers 404 to club B for every club A resource, the same as for one that does not exist", async () => {
    const urls = [
      `/api/v1/clubs/${m.clubA.id}`,
      `/api/v1/clubs/${m.clubA.id}/groups`,
      `/api/v1/groups/${m.team.id}`,
      `/api/v1/groups/${m.section.id}/members`,
      `/api/v1/people/${m.member.id}?clubId=${m.clubA.id}`,
      `/api/v1/people/${m.member.id}`,
      `/api/v1/clubs/${m.clubA.id}/members`,
      `/api/v1/clubs/${m.clubA.id}/members/facets`,
      `/api/v1/clubs/${m.clubA.id}/member-exports`,
      `/api/v1/clubs/${m.clubA.id}/member-imports`,
      `/api/v1/clubs/${m.clubA.id}/member-imports/${uuidv7()}`,
      `/api/v1/clubs/${m.clubA.id}/members/${m.child.id}/guardians`,
      `/api/v1/clubs/${m.clubA.id}/duplicates`,
      `/api/v1/me/wards/${m.child.id}/guardians`,
      `/api/v1/clubs/${m.clubA.id}/locations`,
      `/api/v1/clubs/${m.clubA.id}/activities?from=2026-01-01T00:00:00Z&to=2026-12-31T00:00:00Z`,
      `/api/v1/groups/${m.team.id}/activities?from=2026-01-01T00:00:00Z&to=2026-12-31T00:00:00Z`,
      `/api/v1/activities/${m.activityId}`,
      `/api/v1/activity-series/${m.seriesId}`,
      `/api/v1/activities/${m.activityId}/responses/summary`,
      `/api/v1/activities/${m.activityId}/responses`,
      `/api/v1/activities/${m.activityId}/attendance`,
      `/api/v1/activities/${m.activityId}/invitees`,
      `/api/v1/groups/${m.team.id}/attendance?from=2026-01-01T00:00:00Z&to=2026-12-31T00:00:00Z`,
      `/api/v1/events/${m.eventId}`,
      `/api/v1/events/${m.eventId}/registrations`,
      `/api/v1/groups/${m.team.id}/events`,
    ];
    for (const url of urls) {
      const res = await get(m.outsider.id, url, { mfa: true });
      expect(res.statusCode, url).toBe(404);
    }
    const missing = await get(m.outsider.id, `/api/v1/groups/${uuidv7()}`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({
      type: expect.stringContaining("#not-found") as unknown,
    });
  });

  it("answers 403 to someone related to the club who lacks the permission", async () => {
    const res = await get(m.relative.id, `/api/v1/groups/${m.team.id}/members`);
    expect(res.statusCode).toBe(403);
  });
});

describe("reads", () => {
  it("GET /me/clubs lists clubs with membership and roles", async () => {
    const res = await get(m.registrar.id, "/api/v1/me/clubs");
    expect(res.json()).toEqual({
      clubs: [
        expect.objectContaining({
          club: expect.objectContaining({ id: m.clubA.id }) as unknown,
          membership: { status: "active", membershipType: "active" },
          roles: ["registrar"],
        }),
      ],
    });
    const outsiderClubs = (await get(m.operator.id, "/api/v1/me/clubs")).json<{
      clubs: unknown[];
    }>();
    expect(outsiderClubs.clubs).toEqual([]);
  });

  it("GET /me/clubs lists the club-level permissions, locale and time zone", async () => {
    const permissions = async (personId: string) =>
      (await get(personId, "/api/v1/me/clubs")).json<{
        clubs: { club: { defaultLocale: string; timeZone: string }; permissions: string[] }[];
      }>().clubs[0];
    expect((await permissions(m.registrar.id))?.permissions).toEqual([
      "club.read",
      "club.members.read",
      "club.members.manage",
      "club.members.export",
      "club.members.add",
      "club.members.import",
      "club.activities.read",
      "club.events.read",
      "club.guardians.manage",
      "club.join_requests.manage",
      "club.invitations.manage",
    ]);
    // Listed without a second factor; the endpoints ask for it.
    expect((await permissions(m.manager.id))?.permissions).toEqual(
      expect.arrayContaining(["club.settings.update", "club.roles.manage", "club.members.read"]),
    );
    const member = await permissions(m.member.id);
    expect(member?.permissions).toEqual(["club.read", "club.events.read"]);
    expect(member?.club).toMatchObject({ defaultLocale: "sv-SE", timeZone: "Europe/Stockholm" });
  });

  it("GET /me/groups lists my groups and my wards' groups with functions", async () => {
    type MyGroups = {
      groups: { group: { id: string }; club: { id: string }; functions: string[] }[];
      wards: { personId: string; groups: { group: { id: string } }[] }[];
    };
    const coach = (await get(m.coach.id, "/api/v1/me/groups")).json<MyGroups>();
    expect(coach.groups).toEqual([
      expect.objectContaining({
        group: expect.objectContaining({ id: m.team.id }) as unknown,
        club: expect.objectContaining({ id: m.clubA.id }) as unknown,
        functions: ["head_coach"],
      }),
    ]);
    expect(coach.wards).toEqual([]);

    const parent = (await get(m.parent.id, "/api/v1/me/groups")).json<MyGroups>();
    expect(parent.groups).toEqual([]);
    expect(parent.wards).toEqual([
      { personId: m.child.id, groups: [expect.objectContaining({ functions: ["member"] })] },
    ]);
    expect(parent.wards[0]!.groups[0]!.group.id).toBe(m.team.id);

    // Viewing as the child: the child's own groups.
    const asChild = (
      await get(m.parent.id, "/api/v1/me/groups", { headers: { "x-on-behalf-of": m.child.id } })
    ).json<MyGroups>();
    expect(asChild.groups.map((g) => g.group.id)).toEqual([m.team.id]);
    expect(asChild.wards).toEqual([]);
  });

  it("GET /clubs/:clubId lists the managers; GET /groups/:groupId the visible owners", async () => {
    const club = (await get(m.member.id, `/api/v1/clubs/${m.clubA.id}`)).json<{
      managers: { id: string }[];
    }>();
    expect(club.managers.map((p) => p.id)).toEqual([m.manager.id]);
    const section = (await get(m.member.id, `/api/v1/groups/${m.section.id}`)).json<{
      name: string;
      owners: { id: string; protected: boolean }[];
    }>();
    expect(section.name).toBe("Fotboll");
    expect(section.owners.map((p) => p.id)).toEqual([m.owner.id]);
  });

  it("GET /me/wards lists wards with rights", async () => {
    const res = (await get(m.relative.id, "/api/v1/me/wards")).json<{
      wards: { person: { id: string }; kind: string; rights: string[] }[];
    }>();
    expect(res.wards).toEqual([
      expect.objectContaining({ kind: "relative", rights: ["view_schedule"] }),
    ]);
    expect(res.wards[0]!.person.id).toBe(m.child.id);
  });

  it("GET /clubs/:clubId/groups pages by name; archived groups only for managers", async () => {
    const archived = await s.groups.createGroup(m.clubA.ctx, { name: "Old", kind: "team" });
    await s.groups.archiveGroup(m.clubA.ctx, archived.id);
    const names = async (personId: string, query = "") =>
      (await get(personId, `/api/v1/clubs/${m.clubA.id}/groups${query}`)).json<{
        items: { name: string; id: string }[];
        nextCursor: string | null;
      }>();
    expect((await names(m.member.id)).items.map((g) => g.name)).toEqual([
      "F2016",
      "Fotboll",
      "P2014",
    ]);
    expect((await names(m.manager.id)).items.map((g) => g.name)).toContain("Old");
    const first = await names(m.member.id, "?limit=2");
    expect(first.items).toHaveLength(2);
    const second = await names(m.member.id, `?limit=2&cursor=${first.nextCursor}`);
    expect(second.items.map((g) => g.name)).toEqual(["P2014"]);
    expect(second.nextCursor).toBeNull();
    const bad = await get(m.member.id, `/api/v1/clubs/${m.clubA.id}/groups?cursor=${uuidv7()}`);
    expect(bad.statusCode).toBe(400);
  });

  it("GET /groups/:groupId/members pages by name with a total count", async () => {
    const first = (await get(m.manager.id, `/api/v1/groups/${m.team.id}/members?limit=2`)).json<{
      items: { person: { id: string } }[];
      nextCursor: string;
      totalCount: number;
    }>();
    expect(first.items).toHaveLength(2);
    expect(first.totalCount).toBe(4);
    const rest = (
      await get(m.manager.id, `/api/v1/groups/${m.team.id}/members?cursor=${first.nextCursor}`)
    ).json<{ items: { person: { id: string } }[]; nextCursor: string | null }>();
    expect(rest.items).toHaveLength(2);
    expect(rest.nextCursor).toBeNull();
    const ids = [...first.items, ...rest.items].map((i) => i.person.id).sort();
    expect(ids).toEqual([m.coach.id, m.member.id, m.protectedMember.id, m.child.id].sort());
  });

  it("filters profile fields by relationship", async () => {
    await s.profiles.updateProfile(m.clubA.ctx, m.member.id, { sharedFields: ["phone"] });
    await s.people.updateProfile(actor(m.member.id), m.member.id, { phone: "+46 70 111 11 11" });
    const profile = async (viewer: string, personId: string) =>
      (await get(viewer, `/api/v1/people/${personId}?clubId=${m.clubA.id}`)).json<
        Record<string, unknown>
      >();

    const asTeammate = await profile(m.coach.id, m.member.id);
    expect(asTeammate).toMatchObject({ birthDate: "1985-04-12", phone: "+46 70 111 11 11" });
    expect(asTeammate).not.toHaveProperty("address");

    const coMember = await profile(m.member.id, m.coach.id);
    expect(Object.keys(coMember)).toEqual(["person"]);

    // Leaders see the guardians of a child, with their phone numbers.
    await s.people.updateProfile(actor(m.parent.id), m.parent.id, { phone: "+46 70 222 22 22" });
    const child = await profile(m.coach.id, m.child.id);
    expect(child.guardians).toHaveLength(2);
    expect(child.guardians).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "parent", phone: "+46 70 222 22 22" }),
        expect.objectContaining({ kind: "relative" }),
      ]),
    );
    const asManager = await profile(m.manager.id, m.child.id);
    expect(asManager).toMatchObject({
      club: { membership: { status: "active", membershipType: "active" } },
    });
  });
});

describe("protected identity", () => {
  const rosterIds = async (viewer: string) =>
    (await get(viewer, `/api/v1/groups/${m.team.id}/members`)).json<{
      items: { person: { id: string; protected: boolean } }[];
      totalCount: number;
    }>();

  it("is hidden in member lists for other members, but counted in the total", async () => {
    const roster = await rosterIds(m.member.id);
    expect(roster.items.map((i) => i.person.id)).not.toContain(m.protectedMember.id);
    expect(roster.items).toHaveLength(3);
    expect(roster.totalCount).toBe(4);
    // A guardian of a member sees the same as members.
    expect((await rosterIds(m.parent.id)).items.map((i) => i.person.id)).not.toContain(
      m.protectedMember.id,
    );
  });

  it("is visible with the icon to the coach, the owner of the parent group and the manager", async () => {
    for (const viewer of [m.coach.id, m.owner.id, m.manager.id, m.registrar.id]) {
      const entry = (await rosterIds(viewer)).items.find(
        (i) => i.person.id === m.protectedMember.id,
      );
      expect(entry?.person.protected, viewer).toBe(true);
    }
  });

  it("is visible to the person themselves and to their guardian", async () => {
    const own = (await rosterIds(m.protectedMember.id)).items.find(
      (i) => i.person.id === m.protectedMember.id,
    );
    expect(own?.person.protected).toBe(true);

    // The parent protects the child: the parent still sees them, other members do not.
    await s.people.setProtectedIdentity(actor(m.parent.id), m.child.id, true);
    await dispatchPending();
    const asParent = (await rosterIds(m.parent.id)).items.find((i) => i.person.id === m.child.id);
    expect(asParent?.person.protected).toBe(true);
    expect((await rosterIds(m.member.id)).items.map((i) => i.person.id)).not.toContain(m.child.id);
    expect(
      (await get(m.member.id, `/api/v1/people/${m.child.id}?clubId=${m.clubA.id}`)).statusCode,
    ).toBe(404);
    await s.people.setProtectedIdentity(actor(m.parent.id), m.child.id, false);
    await dispatchPending();
  });

  it("applies the club-level flag after the cache is invalidated", async () => {
    const asMember = async () =>
      (await rosterIds(m.member.id)).items.map((i) => i.person.id).includes(m.coach.id);
    expect(await asMember()).toBe(true);
    await s.profiles.setClubProtection(m.clubA.ctx, m.coach.id, true);
    await dispatchPending();
    expect(await asMember()).toBe(false);
    await s.profiles.setClubProtection(m.clubA.ctx, m.coach.id, false);
    await dispatchPending();
    expect(await asMember()).toBe(true);
  });

  it("is filtered by the database view unless the transaction is privileged", async () => {
    const visible = async (viewer: string, viewerPrivileged: boolean) =>
      t.db.withTenant({ ...actor(viewer, m.clubA.id), viewerPrivileged }, async (tx) => {
        const { rows } = await tx.execute<{ person_id: string }>(
          sql`SELECT person_id FROM app.visible_group_members WHERE group_id = ${m.team.id}`,
        );
        return rows.map((r) => r.person_id);
      });
    expect(await visible(m.member.id, false)).not.toContain(m.protectedMember.id);
    expect(await visible(m.protectedMember.id, false)).toContain(m.protectedMember.id);
    expect(await visible(m.member.id, true)).toContain(m.protectedMember.id);
  });

  it("is masked as an actor in history output for those who may not see them", async () => {
    const service = app.app.get(AuthorizationService);
    const presenter = app.app.get(PersonPresenter);
    const people = app.app.get(PeopleService);
    const request = { id: "test", headers: {} } as never;
    const rows = await people.summaries(actor(m.manager.id, m.clubA.id), [
      m.protectedMember.id,
      m.coach.id,
    ]);
    const asMember = await service.forRequest(request, {
      accountId: null,
      personId: m.member.id,
      mfa: false,
      authTime: null,
      sessionId: null,
      dev: true,
    });
    expect(await presenter.presentActors(asMember, m.clubA.id, [...rows, null])).toEqual([
      { kind: "protected" },
      { kind: "person", person: expect.objectContaining({ id: m.coach.id }) as unknown },
      { kind: "system" },
    ]);
    const asCoach = await service.forRequest(request, {
      accountId: null,
      personId: m.coach.id,
      mfa: false,
      authTime: null,
      sessionId: null,
      dev: true,
    });
    const [shown] = await presenter.presentActors(asCoach, m.clubA.id, rows);
    expect(shown).toMatchObject({ kind: "person", person: { protected: true } });
  });

  it("logs every view of a protected person's profile", async () => {
    const before = (await auditActionsOf(t, m.protectedMember.id)).length;
    const res = await get(
      m.coach.id,
      `/api/v1/people/${m.protectedMember.id}?clubId=${m.clubA.id}`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ person: { protected: true } });
    // Their own view is not logged.
    await get(m.protectedMember.id, `/api/v1/people/${m.protectedMember.id}?clubId=${m.clubA.id}`);
    const actions = await auditActionsOf(t, m.protectedMember.id);
    expect(actions.slice(before)).toEqual(["person.protected.viewed"]);
    const { rows } = await t.query<{ actor_person_id: string; club_id: string }>(
      "admin",
      `SELECT actor_person_id, club_id FROM audit.events
       WHERE resource_id = $1 AND action = 'person.protected.viewed'`,
      [m.protectedMember.id],
    );
    expect(rows).toEqual([{ actor_person_id: m.coach.id, club_id: m.clubA.id }]);
  });

  it("is hidden from an operator with support access", async () => {
    const operator = await buildPerson(s);
    await t.query("admin", "INSERT INTO platform_operators (person_id) VALUES ($1)", [operator.id]);
    await grantSupportAccess(t, m.clubA, operator.id);
    const roster = await get(operator.id, `/api/v1/groups/${m.team.id}/members`, { mfa: true });
    expect(roster.statusCode).toBe(200);
    expect(
      roster.json<{ items: { person: { id: string } }[] }>().items.map((i) => i.person.id),
    ).not.toContain(m.protectedMember.id);
    // Support access needs a second factor.
    expect((await get(operator.id, `/api/v1/clubs/${m.clubA.id}`)).statusCode).toBe(404);
  });
});

describe("acting on behalf of a ward", () => {
  const post = async (personId: string, url: string, headers: Record<string, string> = {}) =>
    inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${await devToken(personId)}`, ...headers },
      payload: { phone: "+46 70 333 33 33" },
    });

  it("records the guardian as actor and the ward as on-behalf-of in history and audit", async () => {
    const res = await post(m.parent.id, `/api/v1/test-authz/people/${m.child.id}/phone`, {
      [ON_BEHALF_OF_HEADER]: m.child.id,
    });
    expect(res.statusCode).toBe(200);
    const { rows: history } = await t.query<{ actor: string; on_behalf: string }>(
      "admin",
      `SELECT actor_person_id AS actor, on_behalf_of_person_id AS on_behalf FROM history.record_changes
       WHERE table_name = 'public.people' AND record_id = $1 AND 'phone' = ANY (changed_columns)
       ORDER BY changed_at DESC LIMIT 1`,
      [m.child.id],
    );
    expect(history).toEqual([{ actor: m.parent.id, on_behalf: m.child.id }]);
    const { rows: events } = await t.query<{ actor: string; on_behalf: string }>(
      "admin",
      `SELECT actor_person_id AS actor, on_behalf_of_person_id AS on_behalf FROM audit.events
       WHERE resource_id = $1 AND action = 'person.updated' ORDER BY created_at DESC LIMIT 1`,
      [m.child.id],
    );
    expect(events).toEqual([{ actor: m.parent.id, on_behalf: m.child.id }]);
  });

  it("evaluates policies as the ward", async () => {
    const asChild = await get(m.parent.id, "/api/v1/me/clubs", {
      headers: { [ON_BEHALF_OF_HEADER]: m.child.id },
    });
    expect(
      asChild.json<{ clubs: { club: { id: string } }[] }>().clubs.map((c) => c.club.id),
    ).toEqual([m.clubA.id]);
  });

  it("is refused without a guardianship with act_on_behalf", async () => {
    const url = `/api/v1/test-authz/people/${m.child.id}/phone`;
    expect((await post(m.relative.id, url, { [ON_BEHALF_OF_HEADER]: m.child.id })).statusCode).toBe(
      403,
    );
    expect((await post(m.coach.id, url, { [ON_BEHALF_OF_HEADER]: m.child.id })).statusCode).toBe(
      403,
    );
    expect((await post(m.parent.id, url, { [ON_BEHALF_OF_HEADER]: "nope" })).statusCode).toBe(400);
  });
});

describe("cache invalidation", () => {
  it("a role change takes effect on the next request", async () => {
    const person = m.member;
    const url = `/api/v1/clubs/${m.clubA.id}/groups`;
    // Warm the cache: members do not see archived groups.
    const archived = await s.groups.createGroup(m.clubA.ctx, { name: "Archived", kind: "team" });
    await s.groups.archiveGroup(m.clubA.ctx, archived.id);
    const names = async () =>
      (await get(person.id, url)).json<{ items: { name: string }[] }>().items.map((g) => g.name);
    expect(await names()).not.toContain("Archived");
    expect(await valkey.get(relationshipSetKey(person.id))).not.toBeNull();

    await s.roles.assignRole(m.clubA.ctx, person.id, "registrar");
    const started = performance.now();
    await dispatchPending();
    const latency = performance.now() - started;
    expect(await names()).toContain("Archived");
    expect(latency).toBeLessThan(1_000);

    await s.roles.endRole(m.clubA.ctx, person.id, "registrar");
    await dispatchPending();
    expect(await names()).not.toContain("Archived");
  });

  it("ending a group membership removes access to the roster", async () => {
    const extra = await buildPerson(s);
    await s.memberships.addMember(m.clubA.ctx, extra.id);
    const gm = await s.memberships.addToGroup(m.clubA.ctx, m.otherTeam.id, extra.id);
    await dispatchPending();
    const url = `/api/v1/groups/${m.otherTeam.id}/members`;
    expect((await get(extra.id, url)).statusCode).toBe(200);
    await s.memberships.endGroupMembership(m.clubA.ctx, gm.id);
    await dispatchPending();
    expect((await get(extra.id, url)).statusCode).toBe(403);
  });
});

describe("performance budgets", () => {
  it("loads the relationship set in one query", async () => {
    const service = app.app.get(AuthorizationService);
    await valkey.del(relationshipSetKey(m.parent.id));
    const { queries, result } = await countQueries(() => service.relationshipSet(m.parent.id));
    expect(queries).toBe(1);
    expect(result.wards).toHaveLength(2);
    const warm = await countQueries(() => service.relationshipSet(m.parent.id));
    expect(warm.queries).toBe(0);
  });

  it("checks a permission in under 0.2 ms with a warm cache", async () => {
    const service = app.app.get(AuthorizationService);
    const request = { id: "bench", headers: {}, params: { clubId: m.clubA.id } } as never;
    const principal = {
      accountId: null,
      personId: m.member.id,
      mfa: false,
      authTime: null,
      sessionId: null,
      dev: true,
    };
    const authz = await service.forRequest(request, principal);
    const runs = 2_000;
    const started = performance.now();
    for (let i = 0; i < runs; i++) await service.authorize(authz, "club.read", request);
    expect((performance.now() - started) / runs).toBeLessThan(0.2);
  });

  it("GET /groups/:id/members: p95 under 50 ms for 40 members, at most 3 queries", async () => {
    const group = await s.groups.createGroup(m.clubA.ctx, { name: "Forty", kind: "team" });
    for (let i = 0; i < 40; i++) {
      const p = await buildPerson(s, { email: null, protectedIdentity: i % 10 === 0 });
      await s.memberships.addMember(m.clubA.ctx, p.id);
      await s.memberships.addToGroup(m.clubA.ctx, group.id, p.id);
    }
    await s.memberships.addToGroup(m.clubA.ctx, group.id, m.member.id);
    await dispatchPending();
    const token = await devToken(m.member.id);
    const request = () =>
      inject({
        method: "GET",
        url: `/api/v1/groups/${group.id}/members?limit=50`,
        headers: { authorization: `Bearer ${token}` },
      });
    // Warm up (relationship set, protected set, JIT).
    for (let i = 0; i < 5; i++) expect((await request()).statusCode).toBe(200);

    const { queries, result } = await countQueries(request);
    expect(result.json<{ items: unknown[]; totalCount: number }>()).toMatchObject({
      totalCount: 41,
    });
    expect(result.json<{ items: unknown[] }>().items).toHaveLength(37);
    expect(queries).toBeLessThanOrEqual(3);

    const times: number[] = [];
    for (let i = 0; i < 50; i++) {
      const started = performance.now();
      await request();
      times.push(performance.now() - started);
    }
    times.sort((x, y) => x - y);
    const p95 = times[Math.ceil(times.length * 0.95) - 1]!;
    expect(p95).toBeLessThan(50);
  });
});
