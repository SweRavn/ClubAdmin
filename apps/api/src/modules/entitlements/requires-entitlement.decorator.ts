// SPDX-License-Identifier: AGPL-3.0-only
import type { EntitlementFeature } from "@clubadmin/shared";
import { SetMetadata } from "@nestjs/common";

export const REQUIRES_ENTITLEMENT = "clubadmin:requires-entitlement";

/**
 * The endpoint needs the club's entitlement to the feature (the club comes
 * from the endpoint's club, group or person resource): 402
 * entitlement-required when the plan does not include it, 404 when the
 * feature is switched off for the installation (FEATURE_*=false).
 */
export const RequiresEntitlement = (feature: EntitlementFeature) =>
  SetMetadata(REQUIRES_ENTITLEMENT, feature);
