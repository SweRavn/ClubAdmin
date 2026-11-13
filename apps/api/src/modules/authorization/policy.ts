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

/** Who may create clubs in this installation (CLUB_CREATION, ADR 0018). */
export type ClubCreationMode = "open" | "approval" | "operators_only";

/** The installation as a whole (operator endpoints, club creation); no IDs. */
export interface PlatformResource {
  kind: "platform";
  clubCreation: ClubCreationMode;
}

/** A club manager hand-over proposal (:handoverId), readable by its two parties. */
export interface HandoverResource {
  kind: "handover";
  handoverId: string;
  clubId: string;
  fromPersonId: string;
  toPersonId: string;
}

/** An activity or activity series (:activityId, :seriesId) with its groups (P1.4). */
export interface ActivityResource {
  kind: "activity";
  clubId: string;
  /** Its groups, each with its ancestors (nearest first). */
  groups: readonly GroupRef[];
}

/** An event with sign-up (:eventId, P1.6) with its audience groups. */
export interface EventResource {
  kind: "event";
  clubId: string;
  audience: "groups" | "club";
  status: string;
  /** The audience groups, each with its ancestors (empty for a club event). */
  groups: readonly GroupRef[];
}

/** An administrator suspension request (:clubId, :suspensionId; P1.15 A3). */
export interface SuspensionResource {
  kind: "administrator_suspension";
  clubId: string;
  suspensionId: string;
  targetPersonId: string;
  requestedByPersonId: string;
  /** The club's administrators who count, now. */
  administrators: number;
}

/**
 * A chat (:chatId within :clubId; P2.1, ADR 0047) with its groups and the
 * memberships of the actor and their wards in it.
 */
export interface ChatResource {
  kind: "chat";
  clubId: string;
  chatId: string;
  chatKind: "channel" | "direct";
  visibility: "open" | "closed" | null;
  archived: boolean;
  createdByPersonId: string | null;
  /** The group's default channel (everyone in the group). */
  defaultForGroupId: string | null;
  /** The groups it was made for, with their ancestors (none for direct messages and club channels). */
  groups: readonly GroupRef[];
  /** The actor's membership: active, offered (protected identity) or none. */
  membership: "active" | "offered" | null;
  /** Wards of the actor (full guardian) who are active members (ADR 0047 rule 6). */
  wardMembers: readonly string[];
  /** Children are active members (ADR 0047). */
  hasChildren: boolean;
}

/**
 * A folder of the file archive (:folderId within :clubId; P2.2, ADR 0049):
 * the club's or a group's, and whether its audience includes the actor.
 */
export interface FolderResource {
  kind: "folder";
  clubId: string;
  folderId: string;
  /** The group whose folder it is, with its ancestors (none: the club's). */
  group: GroupRef | null;
  /** The audience that applies includes the actor (or one of their wards). */
  inAudience: boolean;
}

/** A file of the archive (:documentId within :clubId; P2.2), as its folder. */
export interface DocumentResource {
  kind: "document";
  clubId: string;
  documentId: string;
  folderId: string;
  group: GroupRef | null;
  /** The document's audience (its own or its folder's) includes the actor. */
  inAudience: boolean;
}

export interface Resources {
  platform: PlatformResource;
  club: ClubResource;
  group: GroupResource;
  person: PersonResource;
  handover: HandoverResource;
  activity: ActivityResource;
  event: EventResource;
  administrator_suspension: SuspensionResource;
  chat: ChatResource;
  folder: FolderResource;
  document: DocumentResource;
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
