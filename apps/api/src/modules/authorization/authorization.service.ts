// SPDX-License-Identifier: AGPL-3.0-only
// The policy engine (ADR 0006). The AuthGuard calls it for every
// authenticated request: forRequest loads the actor (relationship set, from
// Valkey or one query) and resolves X-On-Behalf-Of; authorize loads the
// endpoint's resource scope and evaluates the endpoint's policy.
//
// Denials (docs/api/problems.md): 404 when the actor has no relationship with
// the resource's club, the resource does not exist, or it is a person (a
// person's existence is itself information); 403 otherwise.

import type { Database } from "@clubadmin/db";
import { isUuid, ON_BEHALF_OF_HEADER, type Permission } from "@clubadmin/shared";
import type { FastifyRequest } from "fastify";

import type { Principal } from "../../platform/http/principal.ts";
import { ProblemError } from "../../platform/http/problem-error.ts";
import { policyFor } from "./authorization.policy.ts";
import {
  loadGroupScope,
  loadGroupsOfPeople,
  loadPersonInClub,
  loadRelationshipSet,
} from "./authorization.repository.ts";
import type { AuthorizationCache } from "./authorization-cache.ts";
import type {
  ClubResource,
  GroupResource,
  PersonResource,
  Resource,
  ResourceKind,
} from "./policy.ts";
import { Actor, type RelationshipSet } from "./relationship-set.ts";
import { type RequestAuthorization, tenantContext } from "./request-authorization.ts";

const header = (request: FastifyRequest, name: string): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

const param = (request: FastifyRequest, name: string): string | undefined => {
  const value = (request.params as Record<string, unknown> | undefined)?.[name];
  return typeof value === "string" ? value : undefined;
};

const queryParam = (request: FastifyRequest, name: string): string | undefined => {
  const value = (request.query as Record<string, unknown> | undefined)?.[name];
  return typeof value === "string" && value !== "" ? value : undefined;
};

export class AuthorizationService {
  private readonly db: Database;
  private readonly cache: AuthorizationCache;

  constructor(db: Database, cache: AuthorizationCache) {
    this.db = db;
    this.cache = cache;
  }

  /** The person's relationship set: Valkey (current version) or one query. */
  relationshipSet(personId: string, requestId: string | null = null): Promise<RelationshipSet> {
    return this.cache.relationshipSet(personId, () =>
      this.db.withActor({ actorKind: "person", personId, requestId }, (tx) =>
        loadRelationshipSet(tx, personId),
      ),
    );
  }

  async forRequest(request: FastifyRequest, principal: Principal): Promise<RequestAuthorization> {
    const set = await this.relationshipSet(principal.personId, request.id);
    const options = { principalPersonId: principal.personId, mfa: principal.mfa };
    const onBehalfOf = header(request, ON_BEHALF_OF_HEADER);
    let actor = Actor.of(set, options);
    if (onBehalfOf !== undefined) {
      if (!isUuid(onBehalfOf)) throw new ProblemError("bad-request", { detail: "on_behalf_of" });
      const ward = Actor.onBehalfOf(set, onBehalfOf, options);
      if (!ward) throw new ProblemError("forbidden", { detail: "not_guardian_with_act_on_behalf" });
      actor = ward;
    }
    return {
      principal,
      actor,
      context: {
        actorKind: "person",
        personId: principal.personId,
        onBehalfOf: actor.onBehalfOf,
        requestId: request.id,
      },
      resource: null,
      protectedSets: new Map(),
    };
  }

  /** Checks the permission on the request's resource; on success stores the resource. */
  async authorize(
    authorization: RequestAuthorization,
    permission: Permission,
    request: FastifyRequest,
  ): Promise<void> {
    const policy = policyFor(permission);
    // EndpointRegistry refuses to start with an unknown permission; deny anyway.
    if (!policy) throw new ProblemError("forbidden");
    const resource = await this.loadResource(policy.resource, authorization, request);
    const context = { actor: authorization.actor, resource };
    if (!policy.allows(context)) {
      throw new ProblemError(this.denial(authorization.actor, resource));
    }
    if (policy.requiresMfa(context) && !authorization.actor.mfa) {
      throw new ProblemError("mfa-required", { detail: "mfa_required" });
    }
    authorization.resource = resource;
  }

  private denial(actor: Actor, resource: Resource): "not-found" | "forbidden" {
    if (resource.kind === "person") return "not-found";
    return actor.hasClubRelationship(resource.clubId) ? "forbidden" : "not-found";
  }

  private loadResource(
    kind: ResourceKind,
    authorization: RequestAuthorization,
    request: FastifyRequest,
  ): Promise<Resource> {
    switch (kind) {
      case "club":
        return Promise.resolve(this.clubResource(request));
      case "group":
        return this.groupResource(authorization, request);
      case "person":
        return this.personResource(authorization, request);
    }
  }

  private clubResource(request: FastifyRequest): ClubResource {
    const clubId = param(request, "clubId");
    if (!clubId || !isUuid(clubId)) throw new ProblemError("not-found");
    return { kind: "club", clubId };
  }

  private async groupResource(
    authorization: RequestAuthorization,
    request: FastifyRequest,
  ): Promise<GroupResource> {
    const groupId = param(request, "groupId");
    if (!groupId || !isUuid(groupId)) throw new ProblemError("not-found");
    // Groups are visible only to people related to their club (RLS).
    const scope = await this.db.withActor(authorization.context, (tx) =>
      loadGroupScope(tx, groupId),
    );
    if (!scope) throw new ProblemError("not-found");
    return { kind: "group", groupId, ...scope };
  }

  private async personResource(
    authorization: RequestAuthorization,
    request: FastifyRequest,
  ): Promise<PersonResource> {
    const personId = param(request, "personId");
    if (!personId || !isUuid(personId)) throw new ProblemError("not-found");
    const clubId = queryParam(request, "clubId") ?? null;
    if (clubId !== null && !isUuid(clubId)) throw new ProblemError("bad-request");
    const resource: PersonResource = { kind: "person", personId, clubId, inClub: null, groups: [] };
    const { actor } = authorization;
    const family = actor.isSelf(personId) || actor.isGuardianOf(personId);
    // Without a relationship with the club there is nothing to read there.
    if (clubId === null || (!family && !actor.hasClubRelationship(clubId))) return resource;
    return this.db.withTenant(tenantContext(authorization, clubId), async (tx) => {
      const inClub = await loadPersonInClub(tx, clubId, personId);
      if (!inClub) return resource;
      return { ...resource, inClub, groups: await loadGroupsOfPeople(tx, clubId, [personId]) };
    });
  }
}
