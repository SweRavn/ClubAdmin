// SPDX-License-Identifier: AGPL-3.0-only
// Public interface of the identity module.
export { IdentityModule } from "./identity.module.ts";
export { IdentityService } from "./identity.service.ts";
export { CurrentPrincipal, type Principal, RecentAuth, RequireMfa } from "./principal.ts";
export { SessionsService, type ZitadelUsers, zitadelUsers } from "./sessions.service.ts";
export {
  accessTokenHash,
  isMfa,
  TokenError,
  TokenVerifier,
  type VerifiedToken,
} from "./token-verifier.ts";
