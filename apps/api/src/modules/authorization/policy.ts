// SPDX-License-Identifier: AGPL-3.0-only
// Policies in code (ADR 0006): one per permission, a pure function of the
// actor's relationships and the resource scope its loader read. Every policy
// has allow and deny tests (authorization.policy.test.ts).

import type { Permission } from "@clubadmin/shared";

import type { PersonGroupRow, PersonInClubRow } from "./authorization.repository.ts";
import type { Actor, GroupRef } from "./relationship-set.ts";

export interface ClubResource {
  kind: "club";
  clubId: string;
}

export interface GroupResource extends GroupRef {
  kind: "group";
  archived: boolean;
  ownersCanAppointCoOwners: boolean;
}

export interface PersonResource {
  kind: "person";
  personId: string;
  /** The club whose view is asked for (query clubId), or null. */
  clubId: string | null;
  /** The person's profile in that club; null if they never were a member (or no club). */
  inClub: PersonInClubRow | null;
  /** Their open group memberships in that club, with ancestors. */
  groups: PersonGroupRow[];
}

/** The installation as a whole (operator endpoints); no IDs. */
export interface PlatformResource {
  kind: "platform";
}

export interface Resources {
  platform: PlatformResource;
  club: ClubResource;
  group: GroupResource;
  person: PersonResource;
}
export type ResourceKind = keyof Resources;
export type Resource = Resources[ResourceKind];

export interface PolicyContext<K extends ResourceKind> {
  actor: Actor;
  resource: Resources[K];
}

export interface Policy<K extends ResourceKind = ResourceKind> {
  permission: Permission;
  resource: K;
  allows(context: PolicyContext<K>): boolean;
  /** Allowed only with a second factor (403 mfa-required otherwise). */
  requiresMfa(context: PolicyContext<K>): boolean;
}

export function definePolicy<K extends ResourceKind>(
  permission: Permission,
  resource: K,
  allows: (context: PolicyContext<K>) => boolean,
  options: { mfa?: boolean | ((context: PolicyContext<K>) => boolean) } = {},
): Policy<K> {
  const mfa = options.mfa ?? false;
  return {
    permission,
    resource,
    allows,
    requiresMfa: typeof mfa === "function" ? mfa : () => mfa,
  };
}
