// SPDX-License-Identifier: AGPL-3.0-only
import { uuidv7 } from "@clubadmin/shared";
import { describe, expect, it } from "vitest";

import { actorOf, relationships } from "../../testing/authorization.ts";
import { Actor } from "./relationship-set.ts";

const club = uuidv7();
const team = uuidv7();
const section = uuidv7();
const ward = uuidv7();

describe("Actor", () => {
  it("expands group ownership through the ancestor chain", () => {
    const actor = actorOf(relationships({ ownedGroups: [{ clubId: club, groupId: section }] }));
    expect(actor.ownsGroup({ clubId: club, groupId: team, ancestorIds: [section] })).toBe(true);
    expect(actor.ownsGroup({ clubId: club, groupId: section, ancestorIds: [] })).toBe(true);
    expect(actor.ownsGroup({ clubId: club, groupId: team, ancestorIds: [] })).toBe(false);
  });

  it("holds the permissions of its roles: group roles in their group, club roles everywhere", () => {
    const actor = actorOf(
      relationships({
        groups: [
          { clubId: club, groupId: team, function: "assistant_coach" },
          { clubId: club, groupId: section, function: "member" },
        ],
      }),
    );
    expect(actor.holds("group.lead", { clubId: club, groupId: team })).toBe(true);
    expect(actor.holds("group.lead", { clubId: club, groupId: section })).toBe(false);
    expect(actor.holds("group.participate", { clubId: club, groupId: section })).toBe(true);
    // Not inherited by child groups (P1.15 decision 13), not a club permission.
    expect(
      actor.holds("group.activities.manage", {
        clubId: club,
        groupId: uuidv7(),
        ancestorIds: [team],
      }),
    ).toBe(false);
    expect(actor.holds("group.activities.manage", club)).toBe(false);
    expect(actor.holdsInAnyGroup("group.activities.manage", club)).toBe(true);
    expect(actor.isGroupMember(section)).toBe(true);
    const manager = actorOf(relationships({ roles: [{ clubId: club, role: "club_manager" }] }));
    expect(manager.holds("group.activities.manage", { clubId: club, groupId: team })).toBe(true);
    expect(manager.holds("group.activities.manage", club)).toBe(true);
    expect(manager.holds("club.settings.update", uuidv7())).toBe(false);
  });

  it("checks support grants against the clock and requires a second factor", () => {
    const expiresAt = new Date("2030-01-01T00:00:00Z").toISOString();
    const set = relationships({ operator: true, supportGrants: [{ clubId: club, expiresAt }] });
    expect(
      actorOf(set, { mfa: true, now: new Date("2029-12-31T23:00:00Z") }).hasSupportAccess(club),
    ).toBe(true);
    expect(
      actorOf(set, { mfa: true, now: new Date("2030-01-01T00:00:01Z") }).hasSupportAccess(club),
    ).toBe(false);
    expect(
      actorOf(set, { mfa: false, now: new Date("2029-12-31T23:00:00Z") }).hasSupportAccess(club),
    ).toBe(false);
  });

  it("counts paused members but not applicants or people who left", () => {
    const actor = actorOf(
      relationships({
        memberships: [{ clubId: club, status: "paused", membershipType: "active" }],
      }),
    );
    expect(actor.isClubMember(club)).toBe(true);
    const applicant = actorOf(
      relationships({
        memberships: [{ clubId: club, status: "applied", membershipType: "active" }],
      }),
    );
    expect(applicant.isClubMember(club)).toBe(false);
    expect(applicant.hasClubRelationship(club)).toBe(false);
  });

  describe("on behalf of a ward", () => {
    const guardian = relationships({
      roles: [{ clubId: club, role: "club_manager" }],
      wards: [{ personId: ward, kind: "parent", rights: ["act_on_behalf"] }],
      wardMemberships: [
        { personId: ward, clubId: club, status: "active", membershipType: "active" },
      ],
      wardGroups: [
        { personId: ward, clubId: club, groupId: team, function: "member" },
        { personId: ward, clubId: club, groupId: section, function: "assistant_coach" },
      ],
    });
    const options = { principalPersonId: guardian.personId, mfa: true };

    it("acts with the ward's memberships only", () => {
      const actor = Actor.onBehalfOf(guardian, ward, options)!;
      expect(actor.personId).toBe(ward);
      expect(actor.principalPersonId).toBe(guardian.personId);
      expect(actor.onBehalfOf).toBe(ward);
      expect(actor.isSelf(ward)).toBe(true);
      expect(actor.isClubMember(club)).toBe(true);
      expect(actor.isGroupMember(team)).toBe(true);
      // Never the guardian's roles, nor the ward's leader functions.
      expect(actor.holds("club.settings.update", club)).toBe(false);
      expect(actor.holds("group.lead", { clubId: club, groupId: section })).toBe(false);
      expect(actor.holds("group.participate", { clubId: club, groupId: team })).toBe(true);
    });

    it("needs a guardianship with act_on_behalf", () => {
      expect(Actor.onBehalfOf(guardian, uuidv7(), options)).toBeNull();
      const relative = relationships({
        wards: [{ personId: ward, kind: "relative", rights: ["view_schedule"] }],
      });
      expect(Actor.onBehalfOf(relative, ward, options)).toBeNull();
    });
  });
});
