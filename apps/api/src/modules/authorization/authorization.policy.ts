// SPDX-License-Identifier: AGPL-3.0-only
// The policies (docs/domain-model.md, "Effective permissions"). Exactly one
// per permission in @clubadmin/shared PERMISSIONS; the API refuses to start
// otherwise (EndpointRegistry) and the policy tests cover each with allow
// and deny cases.

import { type Permission, PERMISSIONS, type RegisterAccess } from "@clubadmin/shared";

import {
  type AnnouncementResource,
  type ChatResource,
  type ClubResource,
  definePolicy,
  type DocumentResource,
  type EventResource,
  type FolderResource,
  type PersonResource,
  type Policy,
  type ResourceKind,
  type Resources,
} from "./policy.ts";
import type { Actor, GroupRef } from "./relationship-set.ts";

/**
 * How much of a person's profile the actor sees (field filtering in the
 * profile presenter), or null if the person does not exist for them:
 * - self: the person or a guardian with act_on_behalf (everything);
 * - admin: `club.people.details` in the club (P1.15; club managers and
 *   registrars in the built-in template);
 * - leader: owner (incl. parent groups) of one of the person's groups, or
 *   `group.people.details` in one (the template's leader roles);
 * - member: someone in one of the person's groups (or their guardian), or
 *   support access; never for a protected person (ADR 0022).
 */
export type ProfileAccess = "self" | "admin" | "leader" | "member";

export function profileAccess(actor: Actor, resource: PersonResource): ProfileAccess | null {
  const { personId, clubId, inClub, groups } = resource;
  if (actor.isSelf(personId) || actor.isGuardianOf(personId, "act_on_behalf")) return "self";
  if (!clubId || !inClub) return null;
  if (actor.holds("club.people.details", clubId)) return "admin";
  if (
    groups.some((g) => {
      const group = { clubId, groupId: g.groupId, ancestorIds: g.ancestorIds };
      return actor.ownsGroup(group) || actor.holds("group.people.details", group);
    })
  ) {
    return "leader";
  }
  // The register's readers (club managers since P1.15 A2, the board) see the
  // name, as in the register; protected people only with
  // club.people.protected (club managers always: decision 12).
  if (
    actor.holds("club.members.read", clubId) &&
    (!inClub.protected || actor.holds("club.people.protected", clubId))
  ) {
    return "member";
  }
  if (inClub.protected) return null;
  if (
    groups.some(
      (g) =>
        actor.isGroupMember(g.groupId) || actor.isGuardianOfGroupMember(g.groupId, "act_on_behalf"),
    ) ||
    actor.hasSupportAccess(clubId)
  ) {
    return "member";
  }
  // Contact details shown to the whole club (P1.8a): every insider sees the name and phone.
  if (inClub.contactConsents?.includes("contacts_club") && actor.hasClubRelationship(clubId)) {
    return "member";
  }
  return null;
}

/**
 * Whether a viewer with member access sees the person's shared phone
 * (P1.8a): the person consented to show it to their groups (and the viewer
 * shares one, or is the guardian of someone in one) or to the whole club.
 * Never for a protected person.
 */
export function contactVisible(actor: Actor, resource: PersonResource): boolean {
  const { clubId, inClub, groups } = resource;
  if (!clubId || !inClub || inClub.protected) return false;
  const consents = inClub.contactConsents ?? [];
  if (consents.includes("contacts_club") && actor.hasClubRelationship(clubId)) return true;
  return (
    consents.includes("contacts_group") &&
    groups.some(
      (g) =>
        actor.isGroupMember(g.groupId) || actor.isGuardianOfGroupMember(g.groupId, "act_on_behalf"),
    )
  );
}

/**
 * Who sees a group's activities (P1.4): its members and leaders (any role),
 * their guardians with view_schedule (full guardians hold every right), the
 * group's owners (also of parent groups), and holders of
 * `group.activities.read` (club managers and registrars).
 */
export function canReadGroupActivities(actor: Actor, group: GroupRef): boolean {
  return (
    actor.holds("group.activities.read", group) ||
    actor.ownsGroup(group) ||
    actor.isGroupMember(group.groupId) ||
    actor.isGuardianOfGroupMember(group.groupId, "view_schedule")
  );
}

/**
 * Who plans a group's activities: owners, and holders of
 * `group.activities.manage` (coaches and team managers, club managers).
 */
export function canManageGroupActivities(actor: Actor, group: GroupRef): boolean {
  return actor.ownsGroup(group) || actor.holds("group.activities.manage", group);
}

/**
 * Who leads a group's activities (P1.5: sees every answer, takes
 * attendance): those who manage them and holders of
 * `activity.responses.read` (the group's other leaders; not physios).
 */
export function canLeadGroupActivities(actor: Actor, group: GroupRef): boolean {
  return canManageGroupActivities(actor, group) || actor.holds("activity.responses.read", group);
}

/**
 * Who answers for someone in a group (P1.5): those taking part
 * (`group.participate`), and guardians with the sign_up right (full
 * guardians hold every right).
 */
export function canRespondInGroup(actor: Actor, group: GroupRef): boolean {
  return (
    actor.holds("group.participate", group) ||
    actor.isGuardianOfGroupMember(group.groupId, "sign_up")
  );
}

/**
 * Who reads a group's roster: holders of `group.members.read`
 * (administrators), owners; for active groups also everyone in the group,
 * guardians (with act_on_behalf) of its members, and support access.
 * Protected members are filtered per viewer.
 */
export function canReadGroupMembers(actor: Actor, group: GroupRef, archived = false): boolean {
  if (actor.holds("group.members.read", group) || actor.ownsGroup(group)) return true;
  if (archived) return false;
  return (
    actor.isGroupMember(group.groupId) ||
    actor.isGuardianOfGroupMember(group.groupId, "act_on_behalf") ||
    actor.hasSupportAccess(group.clubId)
  );
}

/**
 * Who organises an event (P1.6): holders of `event.manage` (club managers);
 * for a club event those who create club events (the board); for a group
 * event those who manage every audience group.
 */
export function canManageEvent(actor: Actor, event: EventResource): boolean {
  if (actor.holds("event.manage", event.clubId)) return true;
  if (event.audience === "club") return actor.holds("club.events.create", event.clubId);
  return event.groups.length > 0 && event.groups.every((g) => canManageGroupActivities(actor, g));
}

/**
 * Who sees an event (P1.6): organisers and registrars always; once it is
 * published, its audience: for a group event those who see an audience
 * group's activities, for a club event everyone with a relationship to the
 * club.
 */
export function canReadEvent(actor: Actor, event: EventResource): boolean {
  if (canManageEvent(actor, event) || actor.holds("event.read", event.clubId)) return true;
  if (event.status === "draft") return false;
  return event.audience === "club"
    ? actor.hasClubRelationship(event.clubId)
    : event.groups.some((g) => canReadGroupActivities(actor, g));
}

/**
 * How much of the member register the actor sees (P1.2), or null:
 * - full: `club.members.read` and `club.people.details` (club managers and
 *   registrars: every field, protected members marked);
 * - limited: `club.members.read` alone (the board: name, member number,
 *   membership type, groups; never protected members).
 */
export function registerAccess(actor: Actor, clubId: string): RegisterAccess | null {
  if (!actor.holds("club.members.read", clubId)) return null;
  return actor.holds("club.people.details", clubId) ? "full" : "limited";
}

// --- Chat (P2.1, ADR 0047) ----------------------------------------------------
//
// Who may read, join, write and manage a chat follows from its members and
// the child-safety rules, not from roles alone. A guardian acting on behalf
// of a ward (X-On-Behalf-Of) never reads or writes the ward's chats: guardians
// join visibly in their own name (rule 6).

/** Someone of the chat's groups (any role, or owning one); for club channels, anyone related to the club. */
function insiderOfChat(actor: Actor, chat: ChatResource): boolean {
  if (chat.groups.length === 0) return actor.hasClubRelationship(chat.clubId);
  return chat.groups.some((g) => actor.isGroupMember(g.groupId) || actor.ownsGroup(g));
}

// The file archive (P2.2, ADR 0049 decision 2): its folders and files are
// read by their audience (checked in SQL by the resource loader) and by
// those who manage them: the club's by `club.documents.manage`, a group's
// also by its owners and `group.documents.manage` there. Acting for a ward
// reads as the ward and manages nothing.

/** Manages the club's archive, or the group's when a group is given. */
export function canManageDocuments(actor: Actor, clubId: string, group: GroupRef | null): boolean {
  if (actor.onBehalfOf) return false;
  if (actor.holds("club.documents.manage", clubId)) return true;
  return group !== null && (actor.ownsGroup(group) || actor.holds("group.documents.manage", group));
}

export function canReadDocuments(
  actor: Actor,
  resource: FolderResource | DocumentResource,
): boolean {
  return resource.inAudience || canManageDocuments(actor, resource.clubId, resource.group);
}

// Announcements (P2.3, ADR 0053): read by their audience (checked in SQL by
// the resource loader); sent to the club by `club.announcements.send`, to a
// group also by its owners and `group.announcements.send` there. Their
// writer and those who could send them manage them. Acting for a ward reads
// as the ward and sends nothing.

/** Sends announcements to the club, or to the group when a group is given. */
export function canSendAnnouncements(
  actor: Actor,
  clubId: string,
  group: GroupRef | null,
): boolean {
  if (actor.onBehalfOf) return false;
  if (actor.holds("club.announcements.send", clubId)) return true;
  return (
    group !== null && (actor.ownsGroup(group) || actor.holds("group.announcements.send", group))
  );
}

export function canManageAnnouncement(actor: Actor, resource: AnnouncementResource): boolean {
  if (actor.onBehalfOf) return false;
  if (resource.createdByPersonId === actor.personId) return true;
  return canSendAnnouncements(actor, resource.clubId, resource.group);
}

/** A leader of one of the chat's groups (`group.lead`, P1.15) in a chat with children. */
function leadsChildrensChat(actor: Actor, chat: ChatResource): boolean {
  return chat.hasChildren && chat.groups.some((g) => actor.holds("group.lead", g));
}

/**
 * Who manages a channel (its members, name, archiving): its creator while in
 * it; owners of its groups and holders of `group.channels.manage` there; for
 * club channels holders of `club.channels.create`. Direct messages have no
 * manager.
 */
export function canManageChat(actor: Actor, chat: ChatResource): boolean {
  if (actor.onBehalfOf || chat.chatKind === "direct") return false;
  if (chat.createdByPersonId === actor.personId && chat.membership === "active") return true;
  if (chat.groups.length === 0) return actor.holds("club.channels.create", chat.clubId);
  return chat.groups.some((g) => actor.ownsGroup(g) || actor.holds("group.channels.manage", g));
}

/**
 * Who sees a chat and who is in it: its members (also offered ones), full
 * guardians of a member (rule 6), people of its groups for open channels,
 * its managers, and leaders of its groups when children are in it. Messages
 * are for active members only (the chat service).
 */
export function canReadChat(actor: Actor, chat: ChatResource): boolean {
  if (actor.onBehalfOf) return false;
  if (chat.membership !== null || chat.wardMembers.length > 0) return true;
  if (chat.chatKind === "channel" && chat.visibility === "open" && insiderOfChat(actor, chat)) {
    return true;
  }
  return canManageChat(actor, chat) || leadsChildrensChat(actor, chat);
}

/**
 * Who may join (or accept an offer): open channels for the people of their
 * groups; any chat their child is in for full guardians (rule 6); children's
 * chats of their group for its leaders (rule 6; the guardian rule then adds
 * the children's guardians).
 */
export function canJoinChat(actor: Actor, chat: ChatResource): boolean {
  if (actor.onBehalfOf || chat.archived || chat.membership === "active") return false;
  if (chat.membership === "offered") return true;
  if (chat.chatKind === "direct") return false;
  if (chat.visibility === "open" && insiderOfChat(actor, chat)) return true;
  return chat.wardMembers.length > 0 || leadsChildrensChat(actor, chat);
}

/** Active members write while the chat is not archived. */
export function canPostInChat(actor: Actor, chat: ChatResource): boolean {
  return !actor.onBehalfOf && chat.membership === "active" && !chat.archived;
}

/** The permission held through a club role (club-scope policies, P1.15). */
const holdsInClub =
  (permission: Permission) =>
  ({ actor, resource }: { actor: Actor; resource: { clubId: string } }) =>
    actor.holds(permission, resource.clubId);

export const POLICIES: readonly Policy[] = [
  definePolicy("club.read", "club", ({ actor, resource }) =>
    actor.hasClubRelationship(resource.clubId),
  ),
  definePolicy("club.settings.update", "club", holdsInClub("club.settings.update"), { mfa: true }),
  definePolicy("club.roles.manage", "club", holdsInClub("club.roles.manage"), { mfa: true }),
  // The roles page and who holds what (P1.15 A2): club managers, registrars, the chair.
  definePolicy("club.roles.read", "club", holdsInClub("club.roles.read")),
  // The member register (P1.2): full for administrators, limited for the board.
  definePolicy(
    "club.members.read",
    "club",
    ({ actor, resource }) => registerAccess(actor, resource.clubId) !== null,
  ),
  // Pausing, resuming, ending and retyping memberships: with a second factor,
  // except for those who do it routinely (`club.members.routine`: registrars).
  definePolicy("club.members.manage", "club", holdsInClub("club.members.manage"), {
    mfa: ({ actor, resource }) => !actor.holds("club.members.routine", resource.clubId),
  }),
  // Exports of the register (the controller adds @RecentAuth(15)).
  definePolicy("club.members.export", "club", holdsInClub("club.members.export"), { mfa: true }),
  // Adding a member by hand (P1.3b): registrars; club managers with a second factor.
  definePolicy("club.members.add", "club", holdsInClub("club.members.add"), {
    mfa: ({ actor, resource }) => !actor.holds("club.members.routine", resource.clubId),
  }),
  // Imports from a file (P1.3b): always with a second factor (the controller
  // adds @RecentAuth(15) to confirming).
  definePolicy("club.members.import", "club", holdsInClub("club.members.import"), { mfa: true }),
  // Group structure is not personal data: anyone related to the club sees its
  // groups; archived ones only those who administer them.
  definePolicy(
    "group.read",
    "group",
    ({ actor, resource }) =>
      actor.hasClubRelationship(resource.clubId) &&
      (!resource.archived ||
        actor.holds("club.groups.archived.read", resource.clubId) ||
        actor.ownsGroup(resource)),
  ),
  definePolicy(
    "group.update",
    "group",
    ({ actor, resource }) => actor.holds("group.update", resource) || actor.ownsGroup(resource),
  ),
  // P1.6b: club managers; owners of a group create child groups of it (the
  // service checks the parent).
  definePolicy(
    "club.groups.create",
    "club",
    ({ actor, resource }) =>
      actor.holds("club.groups.create", resource.clubId) || actor.ownsAnyGroup(resource.clubId),
  ),
  definePolicy(
    "group.owners.manage",
    "group",
    ({ actor, resource }) =>
      actor.holds("group.owners.manage", resource) ||
      (resource.ownersCanAppointCoOwners && actor.ownsGroup(resource)),
  ),
  // The roster: administrators, owners, everyone in the group, guardians of
  // its members, and support access. Protected members are filtered per
  // viewer (PersonVisibility).
  definePolicy("group.members.read", "group", ({ actor, resource }) =>
    canReadGroupMembers(actor, resource, resource.archived),
  ),
  // Activities (P1.4). A joint activity is readable through any of its
  // groups and managed only by someone who manages all of them.
  definePolicy("group.activities.read", "group", ({ actor, resource }) =>
    canReadGroupActivities(actor, resource),
  ),
  definePolicy(
    "group.activities.manage",
    "group",
    ({ actor, resource }) => !resource.archived && canManageGroupActivities(actor, resource),
  ),
  definePolicy("activity.read", "activity", ({ actor, resource }) =>
    resource.groups.some((g) => canReadGroupActivities(actor, g)),
  ),
  definePolicy(
    "activity.manage",
    "activity",
    ({ actor, resource }) =>
      resource.groups.length > 0 &&
      resource.groups.every((g) => canManageGroupActivities(actor, g)),
  ),
  // The club calendar (groups and places, no names): administrators and the board.
  definePolicy("club.activities.read", "club", holdsInClub("club.activities.read")),
  definePolicy("club.locations.manage", "club", holdsInClub("club.locations.manage")),
  // P1.6b: leaders add the places they use; they change only their own (the
  // service checks the creator for those who do not manage places).
  definePolicy(
    "club.locations.create",
    "club",
    ({ actor, resource }) =>
      actor.holds("club.locations.create", resource.clubId) ||
      actor.managesAnyGroupActivities(resource.clubId),
  ),
  // Events with sign-up (P1.6).
  definePolicy("club.events.read", "club", ({ actor, resource }) =>
    actor.hasClubRelationship(resource.clubId),
  ),
  // Group events: the service checks that the caller manages each audience
  // group; club events: holders of `club.events.create` (managers, the board).
  definePolicy(
    "club.events.create",
    "club",
    ({ actor, resource }) =>
      actor.holds("club.events.create", resource.clubId) ||
      actor.managesAnyGroupActivities(resource.clubId),
  ),
  definePolicy("event.read", "event", ({ actor, resource }) => canReadEvent(actor, resource)),
  definePolicy("event.manage", "event", ({ actor, resource }) => canManageEvent(actor, resource)),
  // The service checks that personId is the caller or a ward with sign_up in the audience.
  definePolicy(
    "event.register",
    "event",
    ({ actor, resource }) =>
      resource.status !== "draft" &&
      (resource.audience === "club"
        ? actor.isClubMember(resource.clubId) ||
          actor.isGuardianOfClubMember(resource.clubId, "sign_up")
        : resource.groups.some((g) => canRespondInGroup(actor, g))),
  ),
  definePolicy(
    "event.registrations.read",
    "event",
    ({ actor, resource }) =>
      canManageEvent(actor, resource) ||
      actor.holds("event.registrations.read", resource.clubId) ||
      resource.groups.some((g) => canLeadGroupActivities(actor, g)),
  ),
  definePolicy("event.registrations.manage", "event", ({ actor, resource }) =>
    canManageEvent(actor, resource),
  ),
  // Responses and attendance (P1.5). The service checks whose answer it is
  // (the caller or a ward with sign_up, on the roster) and the lock.
  // Leaders of one of its groups answer for its participants too (P1.6b).
  definePolicy("activity.respond", "activity", ({ actor, resource }) =>
    resource.groups.some((g) => canRespondInGroup(actor, g) || canLeadGroupActivities(actor, g)),
  ),
  definePolicy("activity.responses.read", "activity", ({ actor, resource }) =>
    resource.groups.some((g) => canLeadGroupActivities(actor, g)),
  ),
  // Registrars too: they correct marks after the lock (the service lets
  // only holders of the club-wide permission change locked attendance).
  definePolicy(
    "activity.attendance.manage",
    "activity",
    ({ actor, resource }) =>
      actor.holds("activity.attendance.manage", resource.clubId) ||
      resource.groups.some(
        (g) => actor.holds("activity.attendance.manage", g) || canLeadGroupActivities(actor, g),
      ),
  ),
  definePolicy(
    "group.attendance.read",
    "group",
    ({ actor, resource }) =>
      actor.holds("group.attendance.read", resource) || canLeadGroupActivities(actor, resource),
  ),
  definePolicy(
    "group.members.manage",
    "group",
    ({ actor, resource }) =>
      actor.holds("group.members.manage", resource) || actor.ownsGroup(resource),
  ),
  // Waiting lists (P1.10b, ADR 0043): holders of `group.waitlist.manage`
  // (club managers), and owners of the group or a parent group while it is
  // not archived. Not leaders who do not own it, registrars or members.
  definePolicy(
    "group.waitlist.manage",
    "group",
    ({ actor, resource }) =>
      actor.holds("group.waitlist.manage", resource) ||
      (!resource.archived && actor.ownsGroup(resource)),
  ),
  definePolicy(
    "person.profile.read",
    "person",
    ({ actor, resource }) => profileAccess(actor, resource) !== null,
  ),
  definePolicy(
    "person.profile.update",
    "person",
    ({ actor, resource }) =>
      actor.isSelf(resource.personId) || actor.isGuardianOf(resource.personId, "act_on_behalf"),
  ),
  // Global flag: the person or a guardian; club flag (with clubId): holders
  // of `person.protection.set` (club managers), with a second factor.
  definePolicy(
    "person.protection.set",
    "person",
    ({ actor, resource }) =>
      resource.clubId
        ? actor.onBehalfOf === null &&
          resource.inClub !== null &&
          actor.holds("person.protection.set", resource.clubId)
        : actor.isSelf(resource.personId) || actor.isGuardianOf(resource.personId, "act_on_behalf"),
    { mfa: ({ resource }) => resource.clubId !== null },
  ),
  // The person's profile view log (P1.12): the person and guardians who act
  // on their behalf (the database function requires a full guardian).
  definePolicy(
    "person.access_log.read",
    "person",
    ({ actor, resource }) =>
      actor.isSelf(resource.personId) || actor.isGuardianOf(resource.personId, "act_on_behalf"),
  ),
  // Families (P1.3). The ward and every active guardian see the ward's
  // guardians (the presenter shows relatives names only).
  definePolicy(
    "person.guardians.read",
    "person",
    ({ actor, resource }) =>
      actor.isSelf(resource.personId) || actor.isGuardianOf(resource.personId),
  ),
  // Inviting, linking and changing rights: full guardians, and the ward
  // themselves for relatives and contact persons (the service checks the
  // kind and the consent age). Never a relative, never on behalf of someone.
  definePolicy(
    "person.guardians.manage",
    "person",
    ({ actor, resource }) =>
      actor.onBehalfOf === null &&
      (actor.isFullGuardianOf(resource.personId) || actor.isSelf(resource.personId)),
  ),
  // Merging duplicates: a full guardian (of both: the service checks the
  // duplicate), or a holder of `person.merge` (club managers) with a second
  // factor for two members of the club (clubId in the query).
  definePolicy(
    "person.merge",
    "person",
    ({ actor, resource }) =>
      actor.onBehalfOf === null &&
      (actor.isFullGuardianOf(resource.personId) ||
        (resource.clubId !== null &&
          resource.inClub !== null &&
          actor.holds("person.merge", resource.clubId))),
    { mfa: ({ actor, resource }) => !actor.isFullGuardianOf(resource.personId) },
  ),
  // "Give own login": full guardians; holders of `person.own_login.invite`
  // (club managers and registrars) of a club the person is a member of.
  definePolicy(
    "person.own_login.invite",
    "person",
    ({ actor, resource }) =>
      actor.onBehalfOf === null &&
      (actor.isFullGuardianOf(resource.personId) ||
        (resource.clubId !== null &&
          resource.inClub?.membership != null &&
          actor.holds("person.own_login.invite", resource.clubId))),
  ),
  // Consents (P1.8a), in one club (clubId in the query). Status and history:
  // the person, full guardians, holders of `person.consents.read` in the
  // club (club managers, registrars); status only for the owners of the
  // person's groups and holders in one of them (leaders; the service
  // decides what each sees). Not members of the same group, relatives or
  // support.
  definePolicy("person.consents.read", "person", ({ actor, resource }) => {
    const { personId, clubId, inClub, groups } = resource;
    if (!clubId) return false;
    if (actor.isSelf(personId) || actor.isFullGuardianOf(personId)) return true;
    if (!inClub) return false;
    return (
      actor.holds("person.consents.read", clubId) ||
      groups.some((g) => {
        const group = { clubId, groupId: g.groupId, ancestorIds: g.ancestorIds };
        return actor.ownsGroup(group) || actor.holds("person.consents.read", group);
      })
    );
  }),
  // Giving and withdrawing: the person (the service requires the consent
  // age), full guardians (the service allows giving below the consent age,
  // withdrawing until the adult age, and their own contact purposes), and
  // holders of `person.consents.manage` (registrars and club managers)
  // recording a paper consent or a withdrawal on request. Never relatives,
  // step or foster parents, contact persons or leaders.
  definePolicy("person.consents.manage", "person", ({ actor, resource }) => {
    const { personId, clubId, inClub } = resource;
    if (!clubId) return false;
    if (actor.isSelf(personId) || actor.isFullGuardianOf(personId)) return true;
    return (
      actor.onBehalfOf === null && inClub !== null && actor.holds("person.consents.manage", clubId)
    );
  }),
  // A group's consent overview (whom not to photograph): its leaders and
  // owners (also of parent groups), club managers and registrars.
  definePolicy(
    "group.consents.read",
    "group",
    ({ actor, resource }) =>
      actor.holds("group.consents.read", resource) || actor.ownsGroup(resource),
  ),
  // Guardianships as the club sees them (paper applications): club managers
  // and registrars. Ending a full guardian's guardianship needs a club
  // manager with a second factor and a reason (checked by the controller and
  // the service).
  definePolicy("club.guardians.manage", "club", holdsInClub("club.guardians.manage")),
  // History and audit (P1.9, ADR 0042): club managers and registrars only;
  // not owners, leaders, organisers, the person or their family (they get
  // their own history through "download my data"). The audit log and the
  // club-wide changes: club managers with a second factor.
  definePolicy(
    "person.history.read",
    "person",
    ({ actor, resource }) =>
      resource.clubId !== null &&
      resource.inClub !== null &&
      actor.holds("person.history.read", resource.clubId),
  ),
  definePolicy("group.history.read", "group", holdsInClub("group.history.read")),
  definePolicy("activity.history.read", "activity", holdsInClub("activity.history.read")),
  definePolicy("event.history.read", "event", holdsInClub("event.history.read")),
  definePolicy("club.history.read", "club", holdsInClub("club.history.read"), { mfa: true }),
  definePolicy("club.audit.read", "club", holdsInClub("club.audit.read"), { mfa: true }),
  // The club's profile view log and its setting (P1.12): club managers, with
  // a second factor.
  definePolicy("club.profile_views.read", "club", holdsInClub("club.profile_views.read"), {
    mfa: true,
  }),
  definePolicy(
    "club.profile_views.configure",
    "club",
    holdsInClub("club.profile_views.configure"),
    { mfa: true },
  ),
  // Operator endpoints (backup status): platform operators, who are also the
  // administrators of a self-hosted installation; with a second factor.
  definePolicy("ops.backup.read", "platform", ({ actor }) => actor.isOperator(), { mfa: true }),
  // Read-only and suspended clubs (P0.12): operators only, also with billing off.
  definePolicy("club.access_state.update", "club", ({ actor }) => actor.isOperator(), {
    mfa: true,
  }),
  // Billing (routes only with BILLING_ENABLED=true): the catalogue and changes
  // for operators; a club's subscription also for its managers and treasurers.
  definePolicy("billing.plans.read", "platform", ({ actor }) => actor.isOperator(), { mfa: true }),
  definePolicy(
    "billing.subscription.read",
    "club",
    ({ actor, resource }) =>
      actor.isOperator() || actor.holds("billing.subscription.read", resource.clubId),
    { mfa: ({ actor }) => actor.isOperator() },
  ),
  definePolicy("billing.subscription.manage", "club", ({ actor }) => actor.isOperator(), {
    mfa: true,
  }),
  // Billing (P1.13, ADR 0045): club managers choose the plan; club managers
  // and treasurers keep the billing details and read invoices (operators
  // too); the platform tools are for operators. All with a second factor
  // except reading invoices in the club.
  definePolicy(
    "billing.subscription.change",
    "club",
    ({ actor, resource }) =>
      actor.onBehalfOf === null && actor.holds("billing.subscription.change", resource.clubId),
    { mfa: true },
  ),
  definePolicy(
    "billing.account.manage",
    "club",
    ({ actor, resource }) =>
      actor.onBehalfOf === null && actor.holds("billing.account.manage", resource.clubId),
    { mfa: true },
  ),
  definePolicy(
    "billing.invoices.read",
    "club",
    ({ actor, resource }) =>
      actor.isOperator() || actor.holds("billing.invoices.read", resource.clubId),
    { mfa: ({ actor }) => actor.isOperator() },
  ),
  definePolicy("billing.plans.manage", "platform", ({ actor }) => actor.isOperator(), {
    mfa: true,
  }),
  definePolicy("billing.subscriptions.list", "platform", ({ actor }) => actor.isOperator(), {
    mfa: true,
  }),
  definePolicy("billing.invoices.list", "platform", ({ actor }) => actor.isOperator(), {
    mfa: true,
  }),
  definePolicy("billing.invoices.manage", "platform", ({ actor }) => actor.isOperator(), {
    mfa: true,
  }),
  // Joining (P1.1, ADR 0018). Club creation follows CLUB_CREATION: anyone
  // logged in (open, approval: the service then files a request), only
  // operators (operators_only, with a second factor). The service also
  // requires a completed profile.
  definePolicy(
    "club.create",
    "platform",
    ({ actor, resource }) => resource.clubCreation !== "operators_only" || actor.isOperator(),
    { mfa: ({ resource }) => resource.clubCreation === "operators_only" },
  ),
  definePolicy("club.creation.decide", "platform", ({ actor }) => actor.isOperator(), {
    mfa: true,
  }),
  // All waiting lists and the out-of-order decisions (P1.10b): managers and
  // registrars (they approve the club memberships that follow); owners see
  // their own lists only.
  definePolicy("club.waitlists.read", "club", holdsInClub("club.waitlists.read")),
  definePolicy("club.join_requests.manage", "club", holdsInClub("club.join_requests.manage")),
  // Role presets additionally need club.roles.manage (checked by the controller).
  // Holders, and owners of a group of the club (P1.15 A4, decision 7): owners
  // invite to their own groups only and see and revoke only their own
  // invitations (the controller checks each group row).
  definePolicy(
    "club.invitations.manage",
    "club",
    ({ actor, resource }) =>
      actor.holds("club.invitations.manage", resource.clubId) ||
      actor.ownsAnyGroup(resource.clubId),
  ),
  // The successor accepts or declines, the proposer cancels (the service
  // checks which); nobody else sees the proposal.
  definePolicy(
    "club.handover.respond",
    "handover",
    ({ actor, resource }) =>
      actor.onBehalfOf === null &&
      (actor.isSelf(resource.toPersonId) || actor.isSelf(resource.fromPersonId)),
  ),
  // Recovery (ADR 0018): the board chair (the locked permission of the
  // chair's role), when no manager is left (the service checks that), with
  // a second factor.
  definePolicy("club.managers.claim", "club", holdsInClub("club.managers.claim"), { mfa: true }),
  // Recovery by an operator on the club's documented request; gives the
  // operator no access to club data.
  definePolicy("club.managers.reassign", "club", ({ actor }) => actor.isOperator(), {
    mfa: true,
  }),
  // The two-person rule (P1.15 A3): never the target or the initiator; an
  // administrator, the chair when the club has exactly two administrators,
  // or an operator through the documented recovery when it has two or fewer
  // (ADR 0018). The database checks the same in
  // app.confirm_administrator_suspension.
  definePolicy(
    "club.administrators.confirm_suspension",
    "administrator_suspension",
    ({ actor, resource }) =>
      actor.onBehalfOf === null &&
      !actor.isSelf(resource.targetPersonId) &&
      !actor.isSelf(resource.requestedByPersonId) &&
      (actor.holds("club.roles.manage", resource.clubId) ||
        (actor.holds("club.managers.claim", resource.clubId) && resource.administrators === 2) ||
        (actor.isOperator() && resource.administrators <= 2)),
    { mfa: true },
  ),
  // An operator gives a club with fewer than two administrators more time, once (audited).
  definePolicy("club.administrators.extend_grace", "club", ({ actor }) => actor.isOperator(), {
    mfa: true,
  }),
  // Club types and their templates (P1.15 B): operators, with a second factor.
  definePolicy("club_types.read", "platform", ({ actor }) => actor.isOperator(), { mfa: true }),
  definePolicy("club_types.manage", "platform", ({ actor }) => actor.isOperator(), { mfa: true }),
  // Chat (P2.1, ADR 0047). Who is added, and the child-safety rules, are
  // checked by the chat service; these decide who may ask.
  definePolicy(
    "group.channels.create",
    "group",
    ({ actor, resource }) =>
      !actor.onBehalfOf &&
      !resource.archived &&
      (actor.ownsGroup(resource) || actor.holds("group.channels.create", resource)),
  ),
  definePolicy(
    "club.channels.create",
    "club",
    ({ actor, resource }) =>
      !actor.onBehalfOf && actor.holds("club.channels.create", resource.clubId),
  ),
  // Direct messages: anyone related to the club asks; the service applies rules 3 and 4.
  definePolicy(
    "club.chats.direct",
    "club",
    ({ actor, resource }) => !actor.onBehalfOf && actor.hasClubRelationship(resource.clubId),
  ),
  definePolicy("chat.read", "chat", ({ actor, resource }) => canReadChat(actor, resource)),
  definePolicy("chat.join", "chat", ({ actor, resource }) => canJoinChat(actor, resource)),
  definePolicy("chat.post", "chat", ({ actor, resource }) => canPostInChat(actor, resource)),
  definePolicy("chat.manage", "chat", ({ actor, resource }) => canManageChat(actor, resource)),
  // Child safety (P2.1 part B, ADR 0047 rule 7): the club's safeguarding
  // officers, with a second factor (they read reported chats).
  definePolicy("club.safeguarding.handle", "club", holdsInClub("club.safeguarding.handle"), {
    mfa: true,
  }),
  // The file archive (P2.2): the lists show what the audiences let the
  // caller read; managing as canManageDocuments.
  definePolicy("club.documents.read", "club", ({ actor, resource }) =>
    actor.hasClubRelationship(resource.clubId),
  ),
  definePolicy("club.documents.manage", "club", ({ actor, resource }) =>
    canManageDocuments(actor, resource.clubId, null),
  ),
  definePolicy("group.documents.read", "group", ({ actor, resource }) =>
    actor.hasClubRelationship(resource.clubId),
  ),
  definePolicy(
    "group.documents.manage",
    "group",
    ({ actor, resource }) =>
      !resource.archived && canManageDocuments(actor, resource.clubId, resource),
  ),
  definePolicy("folder.read", "folder", ({ actor, resource }) => canReadDocuments(actor, resource)),
  definePolicy("folder.manage", "folder", ({ actor, resource }) =>
    canManageDocuments(actor, resource.clubId, resource.group),
  ),
  definePolicy("document.read", "document", ({ actor, resource }) =>
    canReadDocuments(actor, resource),
  ),
  definePolicy("document.manage", "document", ({ actor, resource }) =>
    canManageDocuments(actor, resource.clubId, resource.group),
  ),
  // Announcements (P2.3): boards show what the audiences let the caller read.
  definePolicy("club.announcements.send", "club", ({ actor, resource }) =>
    canSendAnnouncements(actor, resource.clubId, null),
  ),
  definePolicy(
    "group.announcements.send",
    "group",
    ({ actor, resource }) =>
      !resource.archived && canSendAnnouncements(actor, resource.clubId, resource),
  ),
  definePolicy("group.announcements.read", "group", ({ actor, resource }) =>
    actor.hasClubRelationship(resource.clubId),
  ),
  definePolicy(
    "announcement.read",
    "announcement",
    ({ actor, resource }) => resource.inAudience || canManageAnnouncement(actor, resource),
  ),
  definePolicy("announcement.manage", "announcement", ({ actor, resource }) =>
    canManageAnnouncement(actor, resource),
  ),
];

const byPermission = new Map<Permission, Policy>(POLICIES.map((p) => [p.permission, p]));

export function policyFor(permission: Permission): Policy | undefined {
  return byPermission.get(permission);
}

/**
 * Whether the actor holds a permission on a resource (its one policy), for
 * hints in a response such as which links to show. MFA requirements are not
 * applied here; the endpoints still enforce them.
 */
export function permits<K extends ResourceKind>(
  actor: Actor,
  permission: Permission,
  resource: Resources[K],
): boolean {
  const policy = policyFor(permission);
  return policy?.resource === resource.kind && (policy as Policy<K>).allows({ actor, resource });
}

/**
 * The club-level permissions (policies on the club resource) the actor holds
 * in a club, for navigation hints (GET /me/clubs). MFA requirements are not
 * applied here; the endpoints still enforce them.
 */
export function clubPermissions(actor: Actor, clubId: string): Permission[] {
  const resource: ClubResource = { kind: "club", clubId };
  return POLICIES.filter(
    (p): p is Policy<"club"> =>
      p.resource === "club" && (p as Policy<"club">).allows({ actor, resource }),
  ).map((p) => p.permission);
}

/** Permissions without exactly one policy (the startup check refuses to start). */
export function policyGaps(): string[] {
  const gaps: string[] = PERMISSIONS.filter(
    (p) => POLICIES.filter((policy) => policy.permission === p).length !== 1,
  );
  return gaps;
}
