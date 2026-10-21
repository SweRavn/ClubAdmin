// SPDX-License-Identifier: AGPL-3.0-only
// Public interface of the authorization module (ADR 0006, ADR 0022).
export { AuthorizationModule } from "./authorization.module.ts";
export { type ProfileAccess, profileAccess } from "./authorization.policy.ts";
export { AuthorizationService } from "./authorization.service.ts";
export { EndpointPolicyCheck, endpointPolicyProblems } from "./endpoint-policies.ts";
export { PersonVisibility, type Visibility } from "./person-visibility.service.ts";
export type { ClubResource, GroupResource, PersonResource, ResourceKind } from "./policy.ts";
export { PersonPresenter, type PresentablePerson } from "./presenters/person.presenter.ts";
export { PersonProfilePresenter } from "./presenters/person-profile.presenter.ts";
export { Actor, type RelationshipSet } from "./relationship-set.ts";
export {
  CurrentAuthorization,
  type RequestAuthorization,
  resourceOf,
  tenantContext,
} from "./request-authorization.ts";
