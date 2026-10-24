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
import { canReadEvent, canReadGroupActivities, policyFor } from "./authorization.policy.ts";
import {
  loadActivityScope,
  loadEventScope,
  loadFamilyResourcePerson,
  loadGroupScope,
  loadGroupsOfPeople,
  loadHandoverScope,
  loadPersonInClub,
  loadRelationshipSet,
} from "./authorization.repository.ts";
import type { AuthorizationCache } from "./authorization-cache.ts";
import type {
  ActivityResource,
  ClubCreationMode,
  ClubResource,
  EventResource,
  GroupResource,
  HandoverResource,
  PersonResource,
  Resource,
  ResourceKind,
} from "./policy.ts";
import { Actor, type GroupRef, type RelationshipSet } from "./relationship-set.ts";
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
  private readonly clubCreation: ClubCreationMode;

  constructor(
    db: Database,
    cache: AuthorizationCache,
    options: { clubCreation: ClubCreationMode } = { clubCreation: "operators_only" },
  ) {
    this.db = db;
    this.cache = cache;
    this.clubCreation = options.clubCreation;
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

  /**
   * Groups of a club as policy references (with ancestors and whether they
   * are archived), for decisions about more groups than the route's resource
   * (a joint activity names several). Groups outside the club, or that the
   * actor cannot see, are left out.
   */
  groupRefs(
    authorization: RequestAuthorization,
    clubId: string,
    groupIds: readonly string[],
  ): Promise<(GroupRef & { archived: boolean })[]> {
    return this.db.withActor(authorization.context, async (tx) => {
      const refs = await Promise.all(
        [...new Set(groupIds)].map(async (groupId) => {
          const scope = await loadGroupScope(tx, groupId);
          return scope?.clubId === clubId
            ? [{ clubId, groupId, ancestorIds: scope.ancestorIds, archived: scope.archived }]
            : [];
        }),
      );
      return refs.flat();
    });
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
    if (resource.kind === "platform") return "forbidden";
    if (resource.kind === "person" || resource.kind === "handover") return "not-found";
    if (resource.kind === "activity") {
      return resource.groups.some((g) => canReadGroupActivities(actor, g))
        ? "forbidden"
        : "not-found";
    }
    if (resource.kind === "event") {
      return canReadEvent(actor, resource) ? "forbidden" : "not-found";
    }
    return actor.hasClubRelationship(resource.clubId) ? "forbidden" : "not-found";
  }

  private loadResource(
    kind: ResourceKind,
    authorization: RequestAuthorization,
    request: FastifyRequest,
  ): Promise<Resource> {
    switch (kind) {
      case "platform":
        return Promise.resolve({ kind: "platform", clubCreation: this.clubCreation });
      case "club":
        return Promise.resolve(this.clubResource(request));
      case "group":
        return this.groupResource(authorization, request);
      case "person":
        return this.personResource(authorization, request);
      case "handover":
        return this.handoverResource(authorization, request);
      case "activity":
        return this.activityResource(authorization, request);
      case "event":
        return this.eventResource(authorization, request);
    }
  }

  /**
   * An activity or series with its groups and their ancestors. The scope is
   * read without the club's context (insider_read: people related to the
   * club; IDs only); groups the actor cannot see keep no ancestors, so only
   * direct relations count.
   */
  private async activityResource(
    authorization: RequestAuthorization,
    request: FastifyRequest,
  ): Promise<ActivityResource> {
    const activityId = param(request, "activityId");
    const seriesId = param(request, "seriesId");
    const id = activityId ?? seriesId;
    if (!id || !isUuid(id)) throw new ProblemError("not-found");
    return this.db.withActor(authorization.context, async (tx) => {
      const scope = await loadActivityScope(
        tx,
        activityId ? { activityId } : { seriesId: seriesId! },
      );
      if (!scope) throw new ProblemError("not-found");
      const groups = await Promise.all(
        scope.groupIds.map(async (groupId) => ({
          clubId: scope.clubId,
          groupId,
          ancestorIds: (await loadGroupScope(tx, groupId))?.ancestorIds ?? [],
        })),
      );
      return { kind: "activity" as const, clubId: scope.clubId, groups };
    });
  }

  /** An event with its audience groups and their ancestors (insider_read, IDs only). */
  private async eventResource(
    authorization: RequestAuthorization,
    request: FastifyRequest,
  ): Promise<EventResource> {
    const eventId = param(request, "eventId");
    if (!eventId || !isUuid(eventId)) throw new ProblemError("not-found");
    return this.db.withActor(authorization.context, async (tx) => {
      const scope = await loadEventScope(tx, eventId);
      if (!scope) throw new ProblemError("not-found");
      const groups = await Promise.all(
        scope.groupIds.map(async (groupId) => ({
          clubId: scope.clubId,
          groupId,
          ancestorIds: (await loadGroupScope(tx, groupId))?.ancestorIds ?? [],
        })),
      );
      return {
        kind: "event" as const,
        clubId: scope.clubId,
        audience: scope.audience,
        status: scope.status,
        groups,
      };
    });
  }

  /** Hand-overs are readable only by their two parties (RLS, own_relationships). */
  private async handoverResource(
    authorization: RequestAuthorization,
    request: FastifyRequest,
  ): Promise<HandoverResource> {
    const handoverId = param(request, "handoverId");
    if (!handoverId || !isUuid(handoverId)) throw new ProblemError("not-found");
    const scope = await this.db.withActor(authorization.context, (tx) =>
      loadHandoverScope(tx, handoverId),
    );
    if (!scope) throw new ProblemError("not-found");
    return { kind: "handover", handoverId, ...scope };
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

  /**
   * The person of a person-scoped route: :personId, or the person behind a
   * :guardianshipId, :invitationId (the ward) or :mergeId (the kept person).
   */
  private async personIdOf(
    authorization: RequestAuthorization,
    request: FastifyRequest,
  ): Promise<string> {
    const personId = param(request, "personId");
    if (personId !== undefined) {
      if (!isUuid(personId)) throw new ProblemError("not-found");
      return personId;
    }
    const keys = [
      ["guardianshipId", "guardianship"],
      ["invitationId", "invitation"],
      ["mergeId", "merge"],
    ] as const;
    for (const [name, kind] of keys) {
      const id = param(request, name);
      if (id === undefined) continue;
      if (!isUuid(id)) throw new ProblemError("not-found");
      const found = await this.db.withActor(authorization.context, (tx) =>
        loadFamilyResourcePerson(tx, kind, id),
      );
      if (!found) throw new ProblemError("not-found");
      return found;
    }
    throw new ProblemError("not-found");
  }

  private async personResource(
    authorization: RequestAuthorization,
    request: FastifyRequest,
  ): Promise<PersonResource> {
    const personId = await this.personIdOf(authorization, request);
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
