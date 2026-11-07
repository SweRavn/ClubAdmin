// SPDX-License-Identifier: AGPL-3.0-only
// Public interface of the groups module.
export type {
  ClubGroupCountsRow,
  DecisionRow,
  OpenGroupRow,
  OwnerListRow,
  WaitlistEntry,
} from "./group-waitlist.ts";
export { toGroupResponse } from "./groups.controller.ts";
export { GroupsModule } from "./groups.module.ts";
export { GROUP_PERSON_REFERENCES } from "./groups.references.ts";
export {
  type Group,
  GroupsService,
  type OwnerChangeAllowedBy,
  type Season,
} from "./groups.service.ts";
