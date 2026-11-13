// SPDX-License-Identifier: AGPL-3.0-only
// Public interface of the authorization module (ADR 0006, ADR 0022).
export { AuthorizationModule } from "./authorization.module.ts";
export {
  canJoinChat,
  canLeadGroupActivities,
  canManageChat,
  canManageDocuments,
  canManageEvent,
  canManageGroupActivities,
  canPostInChat,
  canReadChat,
  canReadDocuments,
  canReadEvent,
  canReadGroupActivities,
  canReadGroupMembers,
  canRespondInGroup,
  clubPermissions,
  permits,
  type ProfileAccess,
  profileAccess,
  registerAccess,
} from "./authorization.policy.ts";
export { AuthorizationService } from "./authorization.service.ts";
export { AuthorizationCache } from "./authorization-cache.ts";
export { EndpointPolicyCheck, endpointPolicyProblems } from "./endpoint-policies.ts";
export { PersonVisibility, type Visibility } from "./person-visibility.service.ts";
export type {
  ActivityResource,
  ChatResource,
  ClubResource,
  DocumentResource,
  EventResource,
  FolderResource,
  GroupResource,
  PersonResource,
  ResourceKind,
} from "./policy.ts";
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
export {
  Actor,
  type GroupAssignment,
  type GroupRef,
  type PermissionTarget,
  type RelationshipSet,
  type RoleAssignment,
} from "./relationship-set.ts";
export {
  CurrentAuthorization,
  operatorActor,
  operatorTenant,
  type RequestAuthorization,
  resourceOf,
  tenantContext,
} from "./request-authorization.ts";
