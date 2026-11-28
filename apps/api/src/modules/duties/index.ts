// SPDX-License-Identifier: AGPL-3.0-only
// Public interface of the duties module (P2.6, ADR 0050): duty types,
// shifts (tasks of kind duty_shift, ADR 0052), sign-up, assignment, quotas.
export { DutiesModule } from "./duties.module.ts";
export { DUTY_PERSON_REFERENCES } from "./duties.references.ts";
export type { AssignmentRow, DutyTypeRow, ShiftRow } from "./duties.repository.ts";
export type { MyDutyRow } from "./duties.service.ts";
export { DutiesService } from "./duties.service.ts";
