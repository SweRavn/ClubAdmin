// SPDX-License-Identifier: AGPL-3.0-only
// Public interface of the privacy module (P1.8a, ADR 0041).
export { ClubPrivacyService } from "./club-privacy.service.ts";
export { type ConsentCaller, ConsentsService } from "./consents.service.ts";
export { LeavingService } from "./leaving.service.ts";
export {
  OUTSTANDING_OBLIGATIONS,
  type OutstandingObligation,
  type OutstandingObligationsProvider,
} from "./outstanding-obligations.ts";
export { PrivacyModule } from "./privacy.module.ts";
export { PRIVACY_PERSON_REFERENCES } from "./privacy.references.ts";
