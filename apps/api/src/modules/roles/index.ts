// SPDX-License-Identifier: AGPL-3.0-only
// Public interface of the roles module.
export { ClubRolesModule } from "./club-roles.module.ts";
export {
  type ClubAssignmentRow,
  type ClubRoleRow,
  ClubRolesService,
  lockedPermissionsOf,
  mayAssignGroupRole,
} from "./club-roles.service.ts";
export { RolesModule } from "./roles.module.ts";
export { ROLE_PERSON_REFERENCES } from "./roles.references.ts";
export {
  type Handover,
  HANDOVER_VALID_DAYS,
  type RoleAssignment,
  RolesService,
} from "./roles.service.ts";
