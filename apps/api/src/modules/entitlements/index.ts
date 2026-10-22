// SPDX-License-Identifier: AGPL-3.0-only
export { EntitlementsModule } from "./entitlements.module.ts";
export {
  type ClubAccessRule,
  type ClubEntitlements,
  EntitlementsService,
} from "./entitlements.service.ts";
export { REQUIRES_ENTITLEMENT, RequiresEntitlement } from "./requires-entitlement.decorator.ts";
