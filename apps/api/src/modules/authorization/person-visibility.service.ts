// SPDX-License-Identifier: AGPL-3.0-only
// PersonVisibility (ADR 0022): for a viewer and people in a club context,
// whether each person is shown in full, shown with the protected icon, or not
// shown at all. Computed in bulk from the viewer's relationship set and the
// club's cached protected set; at most one query (groups of protected people)
// when the viewer owns or leads groups.
//
// A protected person is visible to themselves, their guardians and wards,
// the club's managers and registrars, and owners (incl. parent groups) and
// leaders of groups they belong to. Hidden for everyone else.

import type { Database } from "@clubadmin/db";

import { loadGroupsOfPeople, loadProtectedSet } from "./authorization.repository.ts";
import type { AuthorizationCache } from "./authorization-cache.ts";
import type { GroupResource } from "./policy.ts";
import type { Actor } from "./relationship-set.ts";
import type { RequestAuthorization } from "./request-authorization.ts";

export type Visibility = "full" | "protected_visible" | "hidden";

export interface ResolveOptions {
  /**
   * Global protected flags of people whose rows the caller holds (people
   * outside the club's reach, e.g. a guardian who is not a member, are not in
   * the club's protected set).
   */
  flags?: ReadonlyMap<string, boolean>;
  /**
   * The people are members of this group (a roster): owners and leaders of
   * the group see its protected members without another query.
   */
  group?: GroupResource;
}

const JOB = "authorization:visibility";

export class PersonVisibility {
  private readonly db: Database;
  private readonly cache: AuthorizationCache;

  constructor(db: Database, cache: AuthorizationCache) {
    this.db = db;
    this.cache = cache;
  }

  /** People with protected identity in the club (cached; once per request). */
  protectedSet(authorization: RequestAuthorization, clubId: string): Promise<ReadonlySet<string>> {
    let set = authorization.protectedSets.get(clubId);
    if (!set) {
      set = this.cache
        .protectedSet(clubId, () =>
          this.db.withSystem(JOB, { clubId }, (tx) => loadProtectedSet(tx, clubId)),
        )
        .then((ids) => new Set(ids));
      authorization.protectedSets.set(clubId, set);
    }
    return set;
  }

  /** May the viewer see every protected member of this group (and so the whole roster)? */
  privilegedForGroup(viewer: Actor, group: GroupResource): boolean {
    return (
      viewer.hasClubRole(group.clubId, "club_manager", "registrar") ||
      viewer.ownsGroup(group) ||
      viewer.leadsGroup(group.groupId)
    );
  }

  async resolve(
    authorization: RequestAuthorization,
    clubId: string | null,
    personIds: readonly string[],
    options: ResolveOptions = {},
  ): Promise<Map<string, Visibility>> {
    const viewer = authorization.actor;
    const protectedIds = clubId ? await this.protectedSet(authorization, clubId) : new Set();
    const result = new Map<string, Visibility>();
    const undecided: string[] = [];
    for (const id of personIds) {
      if (!protectedIds.has(id) && options.flags?.get(id) !== true) {
        result.set(id, "full");
      } else if (this.isFamily(viewer, id)) {
        result.set(id, "protected_visible");
      } else if (!clubId) {
        result.set(id, "hidden");
      } else if (viewer.hasClubRole(clubId, "club_manager", "registrar")) {
        result.set(id, "protected_visible");
      } else if (options.group && this.privilegedForGroup(viewer, options.group)) {
        result.set(id, "protected_visible");
      } else {
        undecided.push(id);
      }
    }
    if (undecided.length === 0) return result;

    // Owners and leaders see protected members of their groups.
    const leads =
      clubId !== null &&
      (viewer.relationships.ownedGroups.some((o) => o.clubId === clubId) ||
        viewer.relationships.groups.some(
          (g) => g.clubId === clubId && viewer.leadsGroup(g.groupId),
        ));
    const visible = new Set<string>();
    if (leads && clubId) {
      const groups = await this.db.withSystem(JOB, { clubId }, (tx) =>
        loadGroupsOfPeople(tx, clubId, undecided),
      );
      for (const g of groups) {
        if (
          viewer.ownsGroup({ clubId, groupId: g.groupId, ancestorIds: g.ancestorIds }) ||
          viewer.leadsGroup(g.groupId)
        ) {
          visible.add(g.personId);
        }
      }
    }
    for (const id of undecided) result.set(id, visible.has(id) ? "protected_visible" : "hidden");
    return result;
  }

  /** The viewer themselves, their ward (guardian of the person) or their guardian. */
  private isFamily(viewer: Actor, personId: string): boolean {
    return (
      viewer.isSelf(personId) ||
      viewer.isGuardianOf(personId) ||
      viewer.relationships.guardians.some((g) => g.personId === personId)
    );
  }
}
