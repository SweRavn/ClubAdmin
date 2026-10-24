// SPDX-License-Identifier: AGPL-3.0-only
// Public interface of the activities module (P1.4, ADR 0034).
export { toLocationResponse } from "./activities.controller.ts";
export { ActivitiesModule } from "./activities.module.ts";
export { ACTIVITY_PERSON_REFERENCES } from "./activities.references.ts";
export {
  ActivitiesService,
  type ActivityView,
  type Location,
  type SeriesView,
} from "./activities.service.ts";
export { AttendanceService } from "./attendance.service.ts";
