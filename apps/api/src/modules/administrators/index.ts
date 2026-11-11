// SPDX-License-Identifier: AGPL-3.0-only
// Public interface of the administrators module (P1.15 A3).
export { AdministratorsModule } from "./administrators.module.ts";
export { ADMINISTRATOR_PERSON_REFERENCES } from "./administrators.references.ts";
export {
  type AdministratorRow,
  type AdministratorsFacts,
  AdministratorsService,
  administratorsState,
  type SuspensionRow,
} from "./administrators.service.ts";
