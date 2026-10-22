// SPDX-License-Identifier: AGPL-3.0-only
// "Is this club allowed to use X, and how much?" (CLAUDE.md rule 11): the only
// way features ask, whether billing is off (self-hosted) or on (hosted). Also
// enforces the club's access state for every club request: read-only clubs
// refuse changes, suspended clubs everything but exports (ADR 0013).

import { type Database, sql } from "@clubadmin/db";
import type {
  ClubAccessState,
  EntitlementFeature,
  EntitlementLimit,
  EntitlementsResponse,
} from "@clubadmin/shared";

import type { EntitlementsCache } from "../../platform/entitlements/entitlements.cache.ts";
import type {
  ClubEntitlementsBase,
  EntitlementSource,
} from "../../platform/entitlements/entitlements.source.ts";
import { ProblemError } from "../../platform/http/problem-error.ts";

export interface ClubEntitlements extends ClubEntitlementsBase {
  accessState: ClubAccessState;
}

/** How an endpoint treats restricted clubs (EndpointOptions.clubAccess). */
export type ClubAccessRule = "default" | "export" | "exempt";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export class EntitlementsService {
  private readonly db: Database;
  private readonly source: EntitlementSource;
  private readonly cache: EntitlementsCache<ClubEntitlements>;
  private readonly enabled: Record<EntitlementFeature, boolean>;
  readonly billingEnabled: boolean;

  constructor(
    db: Database,
    source: EntitlementSource,
    cache: EntitlementsCache<ClubEntitlements>,
    options: { enabled: Record<EntitlementFeature, boolean>; billingEnabled: boolean },
  ) {
    this.db = db;
    this.source = source;
    this.cache = cache;
    this.enabled = options.enabled;
    this.billingEnabled = options.billingEnabled;
  }

  /** Whether the feature is switched on for the whole installation (FEATURE_*). */
  isEnabled(feature: EntitlementFeature): boolean {
    return this.enabled[feature];
  }

  snapshot(clubId: string): Promise<ClubEntitlements> {
    return this.cache.get(clubId, async () => {
      const [base, accessState] = await Promise.all([
        this.source.load(clubId),
        this.loadAccessState(clubId),
      ]);
      const features = { ...base.features };
      for (const feature of Object.keys(features) as EntitlementFeature[]) {
        features[feature] = features[feature] && this.enabled[feature];
      }
      return { ...base, features, accessState };
    });
  }

  async has(clubId: string, feature: EntitlementFeature): Promise<boolean> {
    return this.enabled[feature] && (await this.snapshot(clubId)).features[feature];
  }

  /** The limit's value, null for unlimited. */
  async limit(clubId: string, key: EntitlementLimit): Promise<number | null> {
    return (await this.snapshot(clubId)).limits[key];
  }

  invalidate(clubId: string): Promise<void> {
    return this.cache.invalidate(clubId);
  }

  /**
   * The club checks for a request (AuthGuard, after authorization): the
   * access state, then the endpoint's entitlement.
   */
  async enforce(request: {
    clubId: string | null;
    method: string;
    feature: EntitlementFeature | undefined;
    clubAccess: ClubAccessRule;
  }): Promise<void> {
    const { clubId, feature } = request;
    if (feature && !this.enabled[feature]) throw new ProblemError("not-found");
    if (!clubId) {
      // A programming error: @RequiresEntitlement needs a club, group or person resource.
      if (feature) throw new Error("@RequiresEntitlement needs an endpoint resource in a club");
      return;
    }
    const club = await this.snapshot(clubId);
    if (request.clubAccess !== "exempt") {
      if (club.accessState === "suspended" && request.clubAccess !== "export") {
        throw new ProblemError("club-suspended");
      }
      if (
        club.accessState === "read_only" &&
        request.clubAccess !== "export" &&
        !READ_METHODS.has(request.method.toUpperCase())
      ) {
        throw new ProblemError("club-read-only");
      }
    }
    if (feature && !club.features[feature]) {
      throw new ProblemError("entitlement-required", { detail: feature });
    }
  }

  async response(clubId: string): Promise<EntitlementsResponse> {
    const club = await this.snapshot(clubId);
    return {
      features: club.features,
      limits: club.limits,
      accessState: club.accessState,
      billingEnabled: this.billingEnabled,
      plan: club.plan,
      subscriptionStatus: club.subscriptionStatus,
      trialEndsAt: club.trialEndsAt?.toISOString() ?? null,
    };
  }

  private async loadAccessState(clubId: string): Promise<ClubAccessState> {
    const { rows } = await this.db.withSystem("entitlements:load", { clubId }, (tx) =>
      tx.execute<{ access_state: ClubAccessState }>(
        sql`SELECT access_state FROM clubs WHERE id = ${clubId}`,
      ),
    );
    return rows[0]?.access_state ?? "active";
  }
}
