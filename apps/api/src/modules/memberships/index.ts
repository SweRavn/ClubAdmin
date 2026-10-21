// SPDX-License-Identifier: AGPL-3.0-only
// Public interface of the memberships module.
export { MembershipsModule } from "./memberships.module.ts";
export {
  JOINING_PERSON_REFERENCES,
  MEMBERSHIP_PERSON_REFERENCES,
} from "./memberships.references.ts";
export {
  type ClubMembership,
  type GroupMember,
  type GroupMembership,
  MembershipsService,
  type MyClubsAndGroups,
} from "./memberships.service.ts";
