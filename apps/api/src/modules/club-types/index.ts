// SPDX-License-Identifier: AGPL-3.0-only
// Public interface of the club types module.
export { ClubTypesModule } from "./club-types.module.ts";
export {
  type ClubTypeRow,
  ClubTypesService,
  isRequiredRole,
  type TemplateRoleRow,
} from "./club-types.service.ts";
