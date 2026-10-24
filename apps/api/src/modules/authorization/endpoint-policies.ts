// SPDX-License-Identifier: AGPL-3.0-only
// Startup check (CLAUDE.md rule 2): every endpoint with a permission names a
// permission that has exactly one policy, declares the resource kind that
// policy checks, and has the path parameter its resource loader reads.

import { Injectable, type OnApplicationBootstrap } from "@nestjs/common";

import {
  EndpointRegistry,
  type RegisteredEndpoint,
} from "../../platform/http/endpoint-registry.ts";
import { policyFor, policyGaps } from "./authorization.policy.ts";

/**
 * Path parameters each resource loader reads, any one of them (the person
 * loader also reads ?clubId and resolves guardianships, guardian invitations
 * and merges to their person; the platform none).
 */
const RESOURCE_PARAMS: Record<string, readonly string[] | null> = {
  platform: null,
  club: [":clubId"],
  group: [":groupId"],
  person: [":personId", ":guardianshipId", ":invitationId", ":mergeId"],
  handover: [":handoverId"],
  activity: [":activityId", ":seriesId"],
  event: [":eventId"],
};

export class EndpointPolicyError extends Error {
  constructor(problems: string[]) {
    super(`Endpoints without a valid policy:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "EndpointPolicyError";
  }
}

export function endpointPolicyProblems(endpoints: readonly RegisteredEndpoint[]): string[] {
  const problems = policyGaps().map((p) => `permission ${p} has no single policy`);
  for (const endpoint of endpoints) {
    if (!("permission" in endpoint.access)) continue;
    const name = `${endpoint.method} ${endpoint.fullPath}`;
    const { permission, resource } = endpoint.access;
    const policy = policyFor(permission);
    if (!policy) {
      problems.push(`${name}: no policy for ${permission}`);
      continue;
    }
    if (policy.resource !== resource) {
      problems.push(`${name}: ${permission} checks a ${policy.resource}, not a ${resource}`);
    }
    const params = RESOURCE_PARAMS[resource] ?? null;
    const segments = endpoint.fullPath.split("/");
    if (params !== null && !params.some((p) => segments.includes(p))) {
      problems.push(
        `${name}: a ${resource} resource needs the path parameter ${params.join(" or ")}`,
      );
    }
  }
  return problems;
}

export function checkEndpointPolicies(endpoints: readonly RegisteredEndpoint[]): void {
  const problems = endpointPolicyProblems(endpoints);
  if (problems.length > 0) throw new EndpointPolicyError(problems);
}

/** Registered in AppModule next to the EndpointRegistry: refuses to start on a problem. */
@Injectable()
export class EndpointPolicyCheck implements OnApplicationBootstrap {
  private readonly registry: EndpointRegistry;

  constructor(registry: EndpointRegistry) {
    this.registry = registry;
  }

  onApplicationBootstrap(): void {
    checkEndpointPolicies(this.registry.all());
  }
}
