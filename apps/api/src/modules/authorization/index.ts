// SPDX-License-Identifier: AGPL-3.0-only
// Public interface of the authorization module (ADR 0006, ADR 0022).
export { AuthorizationModule } from "./authorization.module.ts";
export {
  clubPermissions,
  type ProfileAccess,
  profileAccess,
  registerAccess,
} from "./authorization.policy.ts";
export { AuthorizationService } from "./authorization.service.ts";
export { EndpointPolicyCheck, endpointPolicyProblems } from "./endpoint-policies.ts";
export { PersonVisibility, type Visibility } from "./person-visibility.service.ts";
export type { ClubResource, GroupResource, PersonResource, ResourceKind } from "./policy.ts";
export {
  FamilyPresenter,
  type FamilyViewer,
  type GuardianPerson,
} from "./presenters/family.presenter.ts";
export { MemberImportPresenter } from "./presenters/member-import.presenter.ts";
export { PersonPresenter, type PresentablePerson } from "./presenters/person.presenter.ts";
export { PersonProfilePresenter } from "./presenters/person-profile.presenter.ts";
export {
  type PresentableRegisterRow,
  type RegisterPerson,
  RegisterPresenter,
} from "./presenters/register.presenter.ts";
export { Actor, type RelationshipSet } from "./relationship-set.ts";
export {
  CurrentAuthorization,
  operatorActor,
  operatorTenant,
  type RequestAuthorization,
  resourceOf,
  tenantContext,
} from "./request-authorization.ts";
