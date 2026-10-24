// SPDX-License-Identifier: AGPL-3.0-only
// Allow and deny cases for every policy (CLAUDE.md, "Tests"). The last test
// fails when a permission lacks either kind of case.

import { type Permission, PERMISSIONS, uuidv7 } from "@clubadmin/shared";
import { describe, expect, it } from "vitest";

import {
  actorOf,
  clubResource,
  groupResource,
  personResource,
  relationships,
} from "../../testing/authorization.ts";
import { policyFor, policyGaps, profileAccess, registerAccess } from "./authorization.policy.ts";
import type { Resource } from "./policy.ts";
import { Actor, type RelationshipSet } from "./relationship-set.ts";

const club = uuidv7();
const otherClub = uuidv7();
const section = uuidv7();
const team = uuidv7();
const otherTeam = uuidv7();
const player = uuidv7();
const ward = uuidv7();

const member = (clubId = club): Partial<RelationshipSet> => ({
  memberships: [{ clubId, status: "active", membershipType: "active" }],
});
const as = (overrides: Partial<RelationshipSet>, options: { mfa?: boolean } = {}) =>
  actorOf(relationships(overrides), options);

const manager = as({ ...member(), roles: [{ clubId: club, role: "club_manager" }] }, { mfa: true });
const managerWithoutMfa = as({ ...member(), roles: [{ clubId: club, role: "club_manager" }] });
const registrar = as({ ...member(), roles: [{ clubId: club, role: "registrar" }] });
const treasurer = as({ ...member(), roles: [{ clubId: club, role: "treasurer" }] });
const sectionOwner = as({ ...member(), ownedGroups: [{ clubId: club, groupId: section }] });
const coach = as({
  ...member(),
  groups: [{ clubId: club, groupId: team, function: "head_coach" }],
});
const teammate = as({ ...member(), groups: [{ clubId: club, groupId: team, function: "member" }] });
const plainMember = as(member());
const parentSet = relationships({
  wards: [{ personId: ward, kind: "parent", rights: ["act_on_behalf", "view_schedule"] }],
  wardMemberships: [{ personId: ward, clubId: club, status: "active", membershipType: "active" }],
  wardGroups: [{ personId: ward, clubId: club, groupId: team, function: "member" }],
});
const parent = actorOf(parentSet);
const relative = as({
  wards: [{ personId: ward, kind: "relative", rights: ["view_schedule"] }],
  wardMemberships: [{ personId: ward, clubId: club, status: "active", membershipType: "active" }],
  wardGroups: [{ personId: ward, clubId: club, groupId: team, function: "member" }],
});
const outsider = as({});
const relativeActing = as({
  wards: [{ personId: ward, kind: "relative", rights: ["act_on_behalf", "view_schedule"] }],
});
const onBehalf = Actor.onBehalfOf(parentSet, ward, {
  principalPersonId: parentSet.personId,
  mfa: false,
})!;
const otherClubManager = as({
  ...member(otherClub),
  roles: [{ clubId: otherClub, role: "club_manager" }],
});
const soon = new Date(Date.now() + 3_600_000).toISOString();
const operatorWithGrant = as(
  { operator: true, supportGrants: [{ clubId: club, expiresAt: soon }] },
  { mfa: true },
);
const operatorWithoutGrant = as({ operator: true }, { mfa: true });

const clubR = clubResource(club);
const platformR: Resource = { kind: "platform", clubCreation: "approval" };
const operatorsOnlyR: Resource = { kind: "platform", clubCreation: "operators_only" };
const successorSet = relationships({ ...member() });
const successor = actorOf(successorSet);
const proposerSet = relationships({ ...member(), roles: [{ clubId: club, role: "club_manager" }] });
const proposer = actorOf(proposerSet);
const handoverR: Resource = {
  kind: "handover",
  handoverId: uuidv7(),
  clubId: club,
  fromPersonId: proposerSet.personId,
  toPersonId: successorSet.personId,
};
const chair = as({ ...member(), roles: [{ clubId: club, role: "chair" }] }, { mfa: true });
const teamR = groupResource(club, team, { ancestorIds: [section] });
const archivedTeamR = groupResource(club, team, { ancestorIds: [section], archived: true });
const coOwnersTeamR = groupResource(club, team, {
  ancestorIds: [section],
  ownersCanAppointCoOwners: true,
});
const physio = as({ ...member(), groups: [{ clubId: club, groupId: team, function: "physio" }] });
const relativeWithoutSchedule = as({
  wards: [{ personId: ward, kind: "relative", rights: ["receive_messages"] }],
  wardMemberships: [{ personId: ward, clubId: club, status: "active", membershipType: "active" }],
  wardGroups: [{ personId: ward, clubId: club, groupId: team, function: "member" }],
});
const otherTeamCoach = as({
  ...member(),
  groups: [{ clubId: club, groupId: otherTeam, function: "head_coach" }],
});
const relativeWithSignUp = as({
  wards: [{ personId: ward, kind: "relative", rights: ["view_schedule", "sign_up"] }],
  wardMemberships: [{ personId: ward, clubId: club, status: "active", membershipType: "active" }],
  wardGroups: [{ personId: ward, clubId: club, groupId: team, function: "member" }],
});
const otherLeader = as({
  ...member(),
  groups: [{ clubId: club, groupId: team, function: "other_leader" }],
});
const activityR: Resource = {
  kind: "activity",
  clubId: club,
  groups: [{ clubId: club, groupId: team, ancestorIds: [section] }],
};
const jointActivityR: Resource = {
  kind: "activity",
  clubId: club,
  groups: [
    { clubId: club, groupId: team, ancestorIds: [section] },
    { clubId: club, groupId: otherTeam, ancestorIds: [] },
  ],
};
const eventR = (status: "draft" | "published" = "published"): Resource => ({
  kind: "event",
  clubId: club,
  audience: "groups",
  status,
  groups: [{ clubId: club, groupId: team, ancestorIds: [section] }],
});
const clubEventR: Resource = {
  kind: "event",
  clubId: club,
  audience: "club",
  status: "published",
  groups: [],
};
const playerInTeam = (options: { protected?: boolean } = {}) =>
  personResource(player, club, {
    ...options,
    groups: [{ personId: player, groupId: team, function: "member", ancestorIds: [section] }],
  });

interface Case {
  name: string;
  actor: Actor;
  resource: Resource;
  allowed: boolean;
}

const CASES: Record<Permission, Case[]> = {
  "club.read": [
    { name: "member", actor: plainMember, resource: clubR, allowed: true },
    {
      name: "role without membership",
      actor: as({ roles: [{ clubId: club, role: "auditor" }] }),
      resource: clubR,
      allowed: true,
    },
    { name: "guardian of a member", actor: relative, resource: clubR, allowed: true },
    {
      name: "employee",
      actor: as({ employments: [{ clubId: club, startsOn: "2000-01-01", endsOn: null }] }),
      resource: clubR,
      allowed: true,
    },
    {
      name: "operator with support access",
      actor: operatorWithGrant,
      resource: clubR,
      allowed: true,
    },
    { name: "outsider", actor: outsider, resource: clubR, allowed: false },
    { name: "manager of another club", actor: otherClubManager, resource: clubR, allowed: false },
    {
      name: "applicant",
      actor: as({ memberships: [{ clubId: club, status: "applied", membershipType: "active" }] }),
      resource: clubR,
      allowed: false,
    },
    {
      name: "operator without grant",
      actor: operatorWithoutGrant,
      resource: clubR,
      allowed: false,
    },
    {
      name: "operator with grant but no second factor",
      actor: as({ operator: true, supportGrants: [{ clubId: club, expiresAt: soon }] }),
      resource: clubR,
      allowed: false,
    },
    {
      name: "expired employment",
      actor: as({ employments: [{ clubId: club, startsOn: "2000-01-01", endsOn: "2001-01-01" }] }),
      resource: clubR,
      allowed: false,
    },
  ],
  "club.settings.update": [
    { name: "manager", actor: manager, resource: clubR, allowed: true },
    { name: "treasurer", actor: treasurer, resource: clubR, allowed: false },
    { name: "member", actor: plainMember, resource: clubR, allowed: false },
  ],
  "club.roles.manage": [
    { name: "manager", actor: manager, resource: clubR, allowed: true },
    { name: "registrar", actor: registrar, resource: clubR, allowed: false },
    { name: "manager of another club", actor: otherClubManager, resource: clubR, allowed: false },
  ],
  "club.members.read": [
    { name: "manager", actor: manager, resource: clubR, allowed: true },
    { name: "registrar", actor: registrar, resource: clubR, allowed: true },
    { name: "treasurer (limited)", actor: treasurer, resource: clubR, allowed: true },
    { name: "chair (limited)", actor: chair, resource: clubR, allowed: true },
    {
      name: "auditor",
      actor: as({ ...member(), roles: [{ clubId: club, role: "auditor" }] }),
      resource: clubR,
      allowed: false,
    },
    { name: "coach", actor: coach, resource: clubR, allowed: false },
    { name: "member", actor: plainMember, resource: clubR, allowed: false },
    { name: "manager of another club", actor: otherClubManager, resource: clubR, allowed: false },
  ],
  "club.members.manage": [
    { name: "manager", actor: manager, resource: clubR, allowed: true },
    { name: "registrar", actor: registrar, resource: clubR, allowed: true },
    { name: "treasurer", actor: treasurer, resource: clubR, allowed: false },
    { name: "member", actor: plainMember, resource: clubR, allowed: false },
    { name: "manager of another club", actor: otherClubManager, resource: clubR, allowed: false },
  ],
  "club.members.export": [
    { name: "manager", actor: manager, resource: clubR, allowed: true },
    { name: "registrar", actor: registrar, resource: clubR, allowed: true },
    { name: "chair", actor: chair, resource: clubR, allowed: false },
    { name: "treasurer", actor: treasurer, resource: clubR, allowed: false },
    { name: "manager of another club", actor: otherClubManager, resource: clubR, allowed: false },
  ],
  "club.members.add": [
    { name: "manager", actor: manager, resource: clubR, allowed: true },
    { name: "registrar", actor: registrar, resource: clubR, allowed: true },
    { name: "chair", actor: chair, resource: clubR, allowed: false },
    { name: "coach", actor: coach, resource: clubR, allowed: false },
    { name: "manager of another club", actor: otherClubManager, resource: clubR, allowed: false },
  ],
  "club.members.import": [
    { name: "manager", actor: manager, resource: clubR, allowed: true },
    { name: "registrar", actor: registrar, resource: clubR, allowed: true },
    { name: "treasurer", actor: treasurer, resource: clubR, allowed: false },
    { name: "member", actor: plainMember, resource: clubR, allowed: false },
    { name: "manager of another club", actor: otherClubManager, resource: clubR, allowed: false },
  ],
  "group.activities.read": [
    { name: "player in the team", actor: teammate, resource: teamR, allowed: true },
    { name: "parent of a player", actor: parent, resource: teamR, allowed: true },
    { name: "relative with view_schedule", actor: relative, resource: teamR, allowed: true },
    {
      name: "relative without view_schedule",
      actor: relativeWithoutSchedule,
      resource: teamR,
      allowed: false,
    },
    { name: "owner of the parent group", actor: sectionOwner, resource: teamR, allowed: true },
    { name: "registrar", actor: registrar, resource: teamR, allowed: true },
    { name: "other member of the club", actor: plainMember, resource: teamR, allowed: false },
    { name: "manager of another club", actor: otherClubManager, resource: teamR, allowed: false },
  ],
  "group.activities.manage": [
    { name: "head coach", actor: coach, resource: teamR, allowed: true },
    { name: "owner of the parent group", actor: sectionOwner, resource: teamR, allowed: true },
    { name: "club manager", actor: manager, resource: teamR, allowed: true },
    { name: "physio", actor: physio, resource: teamR, allowed: false },
    { name: "player", actor: teammate, resource: teamR, allowed: false },
    { name: "parent", actor: parent, resource: teamR, allowed: false },
    { name: "coach, archived group", actor: coach, resource: archivedTeamR, allowed: false },
  ],
  "activity.read": [
    { name: "player in its group", actor: teammate, resource: activityR, allowed: true },
    { name: "parent of a player", actor: parent, resource: activityR, allowed: true },
    {
      name: "coach of the other group of a joint activity",
      actor: otherTeamCoach,
      resource: jointActivityR,
      allowed: true,
    },
    {
      name: "relative without view_schedule",
      actor: relativeWithoutSchedule,
      resource: activityR,
      allowed: false,
    },
    { name: "other member of the club", actor: plainMember, resource: activityR, allowed: false },
    { name: "outsider", actor: outsider, resource: activityR, allowed: false },
  ],
  "activity.manage": [
    { name: "head coach", actor: coach, resource: activityR, allowed: true },
    {
      name: "club manager, joint activity",
      actor: manager,
      resource: jointActivityR,
      allowed: true,
    },
    {
      name: "coach of only one group of a joint activity",
      actor: coach,
      resource: jointActivityR,
      allowed: false,
    },
    { name: "player", actor: teammate, resource: activityR, allowed: false },
  ],
  "activity.respond": [
    { name: "player in its group", actor: teammate, resource: activityR, allowed: true },
    {
      name: "relative with sign_up",
      actor: relativeWithSignUp,
      resource: activityR,
      allowed: true,
    },
    { name: "parent acting on behalf", actor: onBehalf, resource: activityR, allowed: true },
    {
      name: "relative with view_schedule only",
      actor: relative,
      resource: activityR,
      allowed: false,
    },
    { name: "coach (not a member)", actor: coach, resource: activityR, allowed: false },
    { name: "outsider", actor: outsider, resource: activityR, allowed: false },
  ],
  "activity.responses.read": [
    { name: "head coach", actor: coach, resource: activityR, allowed: true },
    { name: "other leader", actor: otherLeader, resource: activityR, allowed: true },
    { name: "club manager", actor: manager, resource: activityR, allowed: true },
    {
      name: "coach of the other group of a joint activity",
      actor: otherTeamCoach,
      resource: jointActivityR,
      allowed: true,
    },
    { name: "physio", actor: physio, resource: activityR, allowed: false },
    { name: "player", actor: teammate, resource: activityR, allowed: false },
    { name: "parent", actor: parent, resource: activityR, allowed: false },
  ],
  "activity.attendance.manage": [
    { name: "head coach", actor: coach, resource: activityR, allowed: true },
    { name: "registrar", actor: registrar, resource: activityR, allowed: true },
    { name: "owner of the parent group", actor: sectionOwner, resource: activityR, allowed: true },
    { name: "physio", actor: physio, resource: activityR, allowed: false },
    { name: "player", actor: teammate, resource: activityR, allowed: false },
    {
      name: "manager of another club",
      actor: otherClubManager,
      resource: activityR,
      allowed: false,
    },
  ],
  "club.events.read": [
    { name: "member", actor: plainMember, resource: clubR, allowed: true },
    { name: "parent of a member", actor: parent, resource: clubR, allowed: true },
    { name: "outsider", actor: outsider, resource: clubR, allowed: false },
    { name: "manager of another club", actor: otherClubManager, resource: clubR, allowed: false },
  ],
  "club.events.create": [
    { name: "manager", actor: manager, resource: clubR, allowed: true },
    { name: "chair", actor: chair, resource: clubR, allowed: true },
    { name: "head coach", actor: coach, resource: clubR, allowed: true },
    { name: "player", actor: teammate, resource: clubR, allowed: false },
    { name: "physio", actor: physio, resource: clubR, allowed: false },
  ],
  "event.read": [
    { name: "player in an audience group", actor: teammate, resource: eventR(), allowed: true },
    { name: "parent of a player", actor: parent, resource: eventR(), allowed: true },
    { name: "member, club event", actor: plainMember, resource: clubEventR, allowed: true },
    { name: "head coach, draft", actor: coach, resource: eventR("draft"), allowed: true },
    { name: "player, draft", actor: teammate, resource: eventR("draft"), allowed: false },
    { name: "member of another group", actor: plainMember, resource: eventR(), allowed: false },
    { name: "outsider, club event", actor: outsider, resource: clubEventR, allowed: false },
  ],
  "event.manage": [
    { name: "head coach of the audience group", actor: coach, resource: eventR(), allowed: true },
    { name: "chair, club event", actor: chair, resource: clubEventR, allowed: true },
    { name: "manager", actor: manager, resource: eventR(), allowed: true },
    { name: "chair, group event", actor: chair, resource: eventR(), allowed: false },
    { name: "head coach, club event", actor: coach, resource: clubEventR, allowed: false },
    { name: "player", actor: teammate, resource: eventR(), allowed: false },
  ],
  "event.register": [
    { name: "player in an audience group", actor: teammate, resource: eventR(), allowed: true },
    { name: "relative with sign_up", actor: relativeWithSignUp, resource: eventR(), allowed: true },
    { name: "member, club event", actor: plainMember, resource: clubEventR, allowed: true },
    { name: "player, draft", actor: teammate, resource: eventR("draft"), allowed: false },
    { name: "relative without sign_up", actor: relative, resource: eventR(), allowed: false },
    { name: "member of another group", actor: plainMember, resource: eventR(), allowed: false },
    { name: "outsider, club event", actor: outsider, resource: clubEventR, allowed: false },
  ],
  "event.registrations.read": [
    { name: "head coach", actor: coach, resource: eventR(), allowed: true },
    { name: "other leader", actor: otherLeader, resource: eventR(), allowed: true },
    { name: "registrar", actor: registrar, resource: eventR(), allowed: true },
    { name: "player", actor: teammate, resource: eventR(), allowed: false },
    { name: "parent", actor: parent, resource: eventR(), allowed: false },
  ],
  "event.registrations.manage": [
    { name: "head coach", actor: coach, resource: eventR(), allowed: true },
    { name: "chair, club event", actor: chair, resource: clubEventR, allowed: true },
    { name: "other leader", actor: otherLeader, resource: eventR(), allowed: false },
    { name: "player", actor: teammate, resource: eventR(), allowed: false },
    {
      name: "manager of another club",
      actor: otherClubManager,
      resource: eventR(),
      allowed: false,
    },
  ],
  "group.attendance.read": [
    { name: "head coach", actor: coach, resource: teamR, allowed: true },
    { name: "registrar", actor: registrar, resource: teamR, allowed: true },
    { name: "owner of the parent group", actor: sectionOwner, resource: teamR, allowed: true },
    { name: "player", actor: teammate, resource: teamR, allowed: false },
    { name: "parent", actor: parent, resource: teamR, allowed: false },
    { name: "manager of another club", actor: otherClubManager, resource: teamR, allowed: false },
  ],
  "club.activities.read": [
    { name: "manager", actor: manager, resource: clubR, allowed: true },
    { name: "registrar", actor: registrar, resource: clubR, allowed: true },
    { name: "chair", actor: chair, resource: clubR, allowed: true },
    { name: "coach", actor: coach, resource: clubR, allowed: false },
    { name: "member", actor: plainMember, resource: clubR, allowed: false },
    { name: "manager of another club", actor: otherClubManager, resource: clubR, allowed: false },
  ],
  "club.locations.manage": [
    { name: "manager", actor: manager, resource: clubR, allowed: true },
    { name: "registrar", actor: registrar, resource: clubR, allowed: false },
    { name: "coach", actor: coach, resource: clubR, allowed: false },
    { name: "manager of another club", actor: otherClubManager, resource: clubR, allowed: false },
  ],
  "group.read": [
    { name: "member of the club", actor: plainMember, resource: teamR, allowed: true },
    { name: "guardian of a member", actor: parent, resource: teamR, allowed: true },
    { name: "manager, archived group", actor: manager, resource: archivedTeamR, allowed: true },
    {
      name: "owner of the parent, archived group",
      actor: sectionOwner,
      resource: archivedTeamR,
      allowed: true,
    },
    { name: "member, archived group", actor: teammate, resource: archivedTeamR, allowed: false },
    { name: "outsider", actor: outsider, resource: teamR, allowed: false },
  ],
  "group.update": [
    { name: "manager", actor: manager, resource: teamR, allowed: true },
    { name: "owner of the parent group", actor: sectionOwner, resource: teamR, allowed: true },
    { name: "head coach (not owner)", actor: coach, resource: teamR, allowed: false },
    { name: "registrar", actor: registrar, resource: teamR, allowed: false },
  ],
  "group.owners.manage": [
    { name: "manager", actor: manager, resource: teamR, allowed: true },
    {
      name: "owner when the club allows co-owners",
      actor: sectionOwner,
      resource: coOwnersTeamR,
      allowed: true,
    },
    { name: "owner when the club does not", actor: sectionOwner, resource: teamR, allowed: false },
    { name: "coach", actor: coach, resource: coOwnersTeamR, allowed: false },
  ],
  "group.members.read": [
    { name: "manager", actor: manager, resource: teamR, allowed: true },
    { name: "registrar", actor: registrar, resource: teamR, allowed: true },
    { name: "owner of the parent group", actor: sectionOwner, resource: teamR, allowed: true },
    { name: "coach", actor: coach, resource: teamR, allowed: true },
    { name: "teammate", actor: teammate, resource: teamR, allowed: true },
    { name: "parent of a member", actor: parent, resource: teamR, allowed: true },
    {
      name: "operator with support access",
      actor: operatorWithGrant,
      resource: teamR,
      allowed: true,
    },
    { name: "relative (view_schedule only)", actor: relative, resource: teamR, allowed: false },
    { name: "club member outside the group", actor: plainMember, resource: teamR, allowed: false },
    {
      name: "member of another group",
      actor: as({
        ...member(),
        groups: [{ clubId: club, groupId: otherTeam, function: "member" }],
      }),
      resource: teamR,
      allowed: false,
    },
    { name: "teammate, archived group", actor: teammate, resource: archivedTeamR, allowed: false },
    { name: "outsider", actor: outsider, resource: teamR, allowed: false },
  ],
  "group.members.manage": [
    { name: "manager", actor: manager, resource: teamR, allowed: true },
    { name: "owner of the parent group", actor: sectionOwner, resource: teamR, allowed: true },
    { name: "coach", actor: coach, resource: teamR, allowed: false },
    { name: "teammate", actor: teammate, resource: teamR, allowed: false },
  ],
  "person.profile.read": [
    {
      name: "self without club",
      actor: as({ personId: player }),
      resource: personResource(player, null),
      allowed: true,
    },
    {
      name: "parent of the person",
      actor: parent,
      resource: personResource(ward, club),
      allowed: true,
    },
    { name: "manager", actor: manager, resource: playerInTeam(), allowed: true },
    {
      name: "manager, protected person",
      actor: manager,
      resource: playerInTeam({ protected: true }),
      allowed: true,
    },
    {
      name: "coach of the person's group, protected",
      actor: coach,
      resource: playerInTeam({ protected: true }),
      allowed: true,
    },
    {
      name: "owner of the parent group, protected",
      actor: sectionOwner,
      resource: playerInTeam({ protected: true }),
      allowed: true,
    },
    { name: "teammate", actor: teammate, resource: playerInTeam(), allowed: true },
    { name: "parent of a teammate", actor: parent, resource: playerInTeam(), allowed: true },
    {
      name: "teammate, protected person",
      actor: teammate,
      resource: playerInTeam({ protected: true }),
      allowed: false,
    },
    {
      name: "club member outside the person's groups",
      actor: plainMember,
      resource: playerInTeam(),
      allowed: false,
    },
    {
      name: "relative of the person",
      actor: relative,
      resource: personResource(ward, club),
      allowed: false,
    },
    {
      name: "person not in the club",
      actor: manager,
      resource: personResource(player, club, { inClub: false }),
      allowed: false,
    },
    {
      name: "manager without club context",
      actor: manager,
      resource: personResource(player, null),
      allowed: false,
    },
    { name: "outsider", actor: outsider, resource: playerInTeam(), allowed: false },
  ],
  "person.profile.update": [
    {
      name: "self",
      actor: as({ personId: player }),
      resource: personResource(player, null),
      allowed: true,
    },
    { name: "parent", actor: parent, resource: personResource(ward, null), allowed: true },
    { name: "relative", actor: relative, resource: personResource(ward, null), allowed: false },
    { name: "manager", actor: manager, resource: playerInTeam(), allowed: false },
  ],
  "person.protection.set": [
    {
      name: "self, global flag",
      actor: as({ personId: player }),
      resource: personResource(player, null),
      allowed: true,
    },
    {
      name: "parent, global flag",
      actor: parent,
      resource: personResource(ward, null),
      allowed: true,
    },
    { name: "manager, club flag", actor: manager, resource: playerInTeam(), allowed: true },
    {
      name: "manager, global flag",
      actor: manager,
      resource: personResource(player, null),
      allowed: false,
    },
    { name: "coach, club flag", actor: coach, resource: playerInTeam(), allowed: false },
    {
      name: "relative, global flag",
      actor: relative,
      resource: personResource(ward, null),
      allowed: false,
    },
  ],
  "person.guardians.read": [
    {
      name: "the ward",
      actor: as({ personId: ward }),
      resource: personResource(ward, null),
      allowed: true,
    },
    { name: "a parent", actor: parent, resource: personResource(ward, null), allowed: true },
    { name: "a relative", actor: relative, resource: personResource(ward, null), allowed: true },
    {
      name: "the club's manager",
      actor: manager,
      resource: personResource(ward, club),
      allowed: false,
    },
    { name: "a stranger", actor: outsider, resource: personResource(ward, null), allowed: false },
  ],
  "person.guardians.manage": [
    { name: "a parent", actor: parent, resource: personResource(ward, null), allowed: true },
    {
      name: "the ward themselves",
      actor: as({ personId: ward }),
      resource: personResource(ward, null),
      allowed: true,
    },
    { name: "a relative", actor: relative, resource: personResource(ward, null), allowed: false },
    {
      name: "a relative given act_on_behalf",
      actor: relativeActing,
      resource: personResource(ward, null),
      allowed: false,
    },
    {
      name: "a parent acting on behalf of the ward",
      actor: onBehalf,
      resource: personResource(ward, null),
      allowed: false,
    },
    {
      name: "the club's manager",
      actor: manager,
      resource: personResource(ward, club),
      allowed: false,
    },
  ],
  "person.merge": [
    { name: "a parent", actor: parent, resource: personResource(ward, null), allowed: true },
    {
      name: "the club's manager for a member",
      actor: manager,
      resource: playerInTeam(),
      allowed: true,
    },
    { name: "a registrar", actor: registrar, resource: playerInTeam(), allowed: false },
    { name: "a relative", actor: relative, resource: personResource(ward, null), allowed: false },
    {
      name: "another club's manager",
      actor: otherClubManager,
      resource: personResource(player, club, { inClub: false }),
      allowed: false,
    },
    {
      name: "a parent acting on behalf of the ward",
      actor: onBehalf,
      resource: personResource(ward, null),
      allowed: false,
    },
  ],
  "person.own_login.invite": [
    { name: "a parent", actor: parent, resource: personResource(ward, null), allowed: true },
    {
      name: "the club's registrar for a member",
      actor: registrar,
      resource: playerInTeam(),
      allowed: true,
    },
    {
      name: "the club's manager for a member",
      actor: manager,
      resource: playerInTeam(),
      allowed: true,
    },
    { name: "a coach", actor: coach, resource: playerInTeam(), allowed: false },
    { name: "a relative", actor: relative, resource: personResource(ward, null), allowed: false },
    {
      name: "a parent acting on behalf of the ward",
      actor: onBehalf,
      resource: personResource(ward, null),
      allowed: false,
    },
  ],
  "club.guardians.manage": [
    { name: "club manager", actor: manager, resource: clubR, allowed: true },
    { name: "registrar", actor: registrar, resource: clubR, allowed: true },
    { name: "treasurer", actor: treasurer, resource: clubR, allowed: false },
    { name: "a parent of a member", actor: parent, resource: clubR, allowed: false },
  ],
  "club.access_state.update": [
    { name: "platform operator", actor: operatorWithoutGrant, resource: clubR, allowed: true },
    { name: "club manager", actor: manager, resource: clubR, allowed: false },
  ],
  "billing.plans.read": [
    { name: "platform operator", actor: operatorWithoutGrant, resource: platformR, allowed: true },
    { name: "club manager", actor: manager, resource: platformR, allowed: false },
  ],
  "billing.subscription.read": [
    { name: "club manager", actor: manager, resource: clubR, allowed: true },
    {
      name: "treasurer",
      actor: as({ roles: [{ clubId: club, role: "treasurer" }] }),
      resource: clubR,
      allowed: true,
    },
    { name: "platform operator", actor: operatorWithoutGrant, resource: clubR, allowed: true },
    { name: "plain member", actor: plainMember, resource: clubR, allowed: false },
    { name: "manager of another club", actor: otherClubManager, resource: clubR, allowed: false },
  ],
  "billing.subscription.manage": [
    { name: "platform operator", actor: operatorWithoutGrant, resource: clubR, allowed: true },
    { name: "club manager", actor: manager, resource: clubR, allowed: false },
  ],
  "club.create": [
    { name: "anyone (open or approval)", actor: outsider, resource: platformR, allowed: true },
    {
      name: "operator (operators_only)",
      actor: operatorWithoutGrant,
      resource: operatorsOnlyR,
      allowed: true,
    },
    {
      name: "club manager (operators_only)",
      actor: manager,
      resource: operatorsOnlyR,
      allowed: false,
    },
    {
      name: "outsider (operators_only)",
      actor: outsider,
      resource: operatorsOnlyR,
      allowed: false,
    },
  ],
  "club.creation.decide": [
    { name: "platform operator", actor: operatorWithoutGrant, resource: platformR, allowed: true },
    { name: "club manager", actor: manager, resource: platformR, allowed: false },
  ],
  "club.join_requests.manage": [
    { name: "manager", actor: manager, resource: clubR, allowed: true },
    { name: "registrar", actor: registrar, resource: clubR, allowed: true },
    { name: "treasurer", actor: treasurer, resource: clubR, allowed: false },
    { name: "coach", actor: coach, resource: clubR, allowed: false },
    { name: "manager of another club", actor: otherClubManager, resource: clubR, allowed: false },
  ],
  "club.invitations.manage": [
    { name: "manager", actor: manager, resource: clubR, allowed: true },
    { name: "registrar", actor: registrar, resource: clubR, allowed: true },
    { name: "group owner", actor: sectionOwner, resource: clubR, allowed: false },
    { name: "member", actor: plainMember, resource: clubR, allowed: false },
  ],
  "club.handover.respond": [
    { name: "successor", actor: successor, resource: handoverR, allowed: true },
    { name: "proposer", actor: proposer, resource: handoverR, allowed: true },
    { name: "another manager", actor: manager, resource: handoverR, allowed: false },
    { name: "outsider", actor: outsider, resource: handoverR, allowed: false },
  ],
  "club.managers.claim": [
    { name: "chair", actor: chair, resource: clubR, allowed: true },
    {
      name: "board member",
      actor: as({ ...member(), roles: [{ clubId: club, role: "board_member" }] }),
      resource: clubR,
      allowed: false,
    },
    { name: "member", actor: plainMember, resource: clubR, allowed: false },
  ],
  "club.managers.reassign": [
    { name: "platform operator", actor: operatorWithoutGrant, resource: clubR, allowed: true },
    { name: "club manager", actor: manager, resource: clubR, allowed: false },
    { name: "chair", actor: chair, resource: clubR, allowed: false },
  ],
  "ops.backup.read": [
    { name: "platform operator", actor: operatorWithoutGrant, resource: platformR, allowed: true },
    { name: "club manager", actor: manager, resource: platformR, allowed: false },
    { name: "outsider", actor: outsider, resource: platformR, allowed: false },
  ],
};

describe("policies", () => {
  for (const permission of PERMISSIONS) {
    describe(permission, () => {
      for (const c of CASES[permission]) {
        it(`${c.allowed ? "allows" : "denies"}: ${c.name}`, () => {
          const policy = policyFor(permission)!;
          expect(policy.resource).toBe(c.resource.kind);
          expect(policy.allows({ actor: c.actor, resource: c.resource })).toBe(c.allowed);
        });
      }
    });
  }

  it("has one policy per permission, each with allow and deny cases", () => {
    expect(policyGaps()).toEqual([]);
    for (const permission of PERMISSIONS) {
      const cases = CASES[permission];
      expect(
        cases.some((c) => c.allowed),
        `${permission} allow case`,
      ).toBe(true);
      expect(
        cases.some((c) => !c.allowed),
        `${permission} deny case`,
      ).toBe(true);
    }
  });

  it("requires a second factor to create clubs only where operators create them", () => {
    const create = policyFor("club.create")!;
    expect(create.requiresMfa({ actor: outsider, resource: platformR })).toBe(false);
    expect(create.requiresMfa({ actor: operatorWithoutGrant, resource: operatorsOnlyR })).toBe(
      true,
    );
    expect(policyFor("club.managers.claim")!.requiresMfa({ actor: chair, resource: clubR })).toBe(
      true,
    );
  });

  it("requires a second factor for club administration", () => {
    const settings = policyFor("club.settings.update")!;
    expect(settings.requiresMfa({ actor: managerWithoutMfa, resource: clubR })).toBe(true);
    const merge = policyFor("person.merge")!;
    expect(merge.requiresMfa({ actor: manager, resource: playerInTeam() })).toBe(true);
    expect(merge.requiresMfa({ actor: parent, resource: personResource(ward, null) })).toBe(false);
    const protection = policyFor("person.protection.set")!;
    expect(protection.requiresMfa({ actor: manager, resource: playerInTeam() })).toBe(true);
    expect(protection.requiresMfa({ actor: parent, resource: personResource(ward, null) })).toBe(
      false,
    );
    expect(policyFor("club.read")!.requiresMfa({ actor: plainMember, resource: clubR })).toBe(
      false,
    );
    expect(
      policyFor("ops.backup.read")!.requiresMfa({
        actor: operatorWithoutGrant,
        resource: platformR,
      }),
    ).toBe(true);
  });
});

describe("registerAccess", () => {
  it("gives administrators the full register and the board the limited one", () => {
    expect(registerAccess(manager, club)).toBe("full");
    expect(registerAccess(registrar, club)).toBe("full");
    expect(registerAccess(treasurer, club)).toBe("limited");
    expect(registerAccess(chair, club)).toBe("limited");
    expect(registerAccess(coach, club)).toBeNull();
    expect(registerAccess(otherClubManager, club)).toBeNull();
  });

  it("requires a second factor for exports, and for managers changing memberships", () => {
    const exports = policyFor("club.members.export")!;
    expect(exports.requiresMfa({ actor: registrar, resource: clubR })).toBe(true);
    const manage = policyFor("club.members.manage")!;
    expect(manage.requiresMfa({ actor: managerWithoutMfa, resource: clubR })).toBe(true);
    expect(manage.requiresMfa({ actor: registrar, resource: clubR })).toBe(false);
  });

  it("requires a second factor for imports, and for managers adding members", () => {
    expect(
      policyFor("club.members.import")!.requiresMfa({ actor: registrar, resource: clubR }),
    ).toBe(true);
    const add = policyFor("club.members.add")!;
    expect(add.requiresMfa({ actor: managerWithoutMfa, resource: clubR })).toBe(true);
    expect(add.requiresMfa({ actor: registrar, resource: clubR })).toBe(false);
  });
});

describe("profileAccess", () => {
  it("grades the relationship", () => {
    expect(profileAccess(parent, personResource(ward, club))).toBe("self");
    expect(profileAccess(registrar, playerInTeam())).toBe("admin");
    expect(profileAccess(coach, playerInTeam({ protected: true }))).toBe("leader");
    expect(profileAccess(teammate, playerInTeam())).toBe("member");
    expect(profileAccess(teammate, playerInTeam({ protected: true }))).toBeNull();
  });
});
