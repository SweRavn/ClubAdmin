// SPDX-License-Identifier: AGPL-3.0-only
// Public interface of the guardianships module.
export { GuardianshipsModule } from "./guardianships.module.ts";
export { GUARDIANSHIP_PERSON_REFERENCES } from "./guardianships.references.ts";
export {
  GUARDIAN_INVITATION_VALID_DAYS,
  type Guardianship,
  GuardianshipsService,
} from "./guardianships.service.ts";
