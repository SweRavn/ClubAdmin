// SPDX-License-Identifier: AGPL-3.0-only
// Club invitations (ADR 0018, P1.1): by email, link or short code, with an
// optional group and role preset, an expiry and a use limit. Only a hash of
// the secret is stored (ADR 0032). Accepting makes the person an active
// member and applies the presets, in one transaction under the club's lock.

import {
  type ActorContext,
  audit,
  type Database,
  isUniqueViolation,
  outbox,
  savepoint,
  type TenantContext,
  type Tx,
} from "@clubadmin/db";
import {
  emailInvitationToken,
  hashInvitationSecret,
  invitationUrl,
  randomInvitationCode,
  randomInvitationToken,
} from "@clubadmin/server-kit/invitations";
import type { INVITATION_STATES } from "@clubadmin/shared";
import {
  type CreateInvitationInput,
  CreateInvitationSchema,
  InvitationCodeSchema,
  uuidv7,
} from "@clubadmin/shared";

import { DomainError, isDomainError } from "../../platform/domain/domain-error.ts";
import { actorPersonId, parseInput } from "../../platform/domain/run.ts";
import type { AccountsService } from "../accounts/index.ts";
import type { ClubsService } from "../clubs/index.ts";
import type { GroupsService } from "../groups/index.ts";
import type { MembershipsService } from "../memberships/index.ts";
import type { ClubRoleRow, ClubRolesService, RolesService } from "../roles/index.ts";
import type { JoinRequestsService } from "./join-requests.service.ts";
import * as repo from "./joining.repository.ts";

export type Invitation = repo.InvitationRow & {
  /** The groups it adds to, each with its group role (P1.15 A4; the old `groupId` included). */
  groups: { groupId: string; roleId: string }[];
};
export type InvitationState = (typeof INVITATION_STATES)[number];

export function invitationState(invitation: repo.InvitationRow, now = new Date()): InvitationState {
  if (invitation.revokedAt) return "revoked";
  if (invitation.maxUses !== null && invitation.uses >= invitation.maxUses) return "used_up";
  if (invitation.expiresAt <= now) return "expired";
  return "active";
}

/** The secret as the caller holds it: a link token or a code (normalised). */
export type InvitationSecret = { token: string } | { code: string };

const secretHash = (secret: InvitationSecret): string =>
  "token" in secret
    ? hashInvitationSecret(secret.token)
    : hashInvitationSecret(parseInput(InvitationCodeSchema, secret.code));

/** Days the second administrator's invitation stays valid. */
const ADMINISTRATOR_INVITATION_DAYS = 14;

export class InvitationsService {
  private readonly db: Database;
  private readonly clubs: ClubsService;
  private readonly groups: GroupsService;
  private readonly memberships: MembershipsService;
  private readonly roles: RolesService;
  private readonly clubRoles: ClubRolesService;
  private readonly accounts: AccountsService;
  private readonly joinRequests: JoinRequestsService;
  private readonly tokenKey: string | undefined;
  private readonly webUrl: string;

  constructor(
    db: Database,
    deps: {
      clubs: ClubsService;
      groups: GroupsService;
      memberships: MembershipsService;
      roles: RolesService;
      clubRoles: ClubRolesService;
      accounts: AccountsService;
      joinRequests: JoinRequestsService;
      /** INVITATION_TOKEN_KEY; without it email invitations are refused. */
      tokenKey: string | undefined;
      webUrl: string;
    },
  ) {
    this.db = db;
    this.clubs = deps.clubs;
    this.groups = deps.groups;
    this.memberships = deps.memberships;
    this.roles = deps.roles;
    this.clubRoles = deps.clubRoles;
    this.accounts = deps.accounts;
    this.joinRequests = deps.joinRequests;
    this.tokenKey = deps.tokenKey;
    this.webUrl = deps.webUrl;
  }

  /**
   * Creates an invitation and returns its link or code once. The controller
   * has checked each group row and resolved its role (P1.15 A4: the
   * no-escalation rule per row); `groups` is the result, the old `groupId`
   * included. `mayPresetRole`: the caller administers roles; `mfa`: they
   * logged in with a second factor (a club role grants a role, so it needs
   * both, as assigning one does). `administrator`: the invitation gives a
   * club role with club.roles.manage, the only kind allowed while the club
   * needs administrators (A3).
   */
  create(
    context: TenantContext,
    input: CreateInvitationInput,
    options: {
      mayPresetRole: boolean;
      mfa: boolean;
      groups?: readonly { groupId: string; roleId: string }[];
      clubRoleId?: string | null;
      administrator?: boolean;
    },
  ): Promise<{ invitation: Invitation; url: string | null; code: string | null }> {
    const data = parseInput(CreateInvitationSchema, input);
    const me = actorPersonId(context);
    const groupRows = options.groups ?? [];
    const administrator = options.administrator ?? data.rolePreset === "club_manager";
    const presetsRole = Boolean(data.rolePreset || options.clubRoleId);
    if (presetsRole && !options.mayPresetRole) throw new DomainError("role_preset_not_allowed");
    // A manager without a second factor is told so (and offered the MFA login), not refused as a non-manager.
    if (presetsRole && !options.mfa) throw new DomainError("mfa_required");
    if (data.kind === "email" && !this.tokenKey) {
      throw new DomainError("invitation_email_unavailable");
    }
    return this.db.withTenant(context, async (tx) => {
      if (!administrator && (await this.clubs.needsAdministratorsInTx(tx, context.clubId))) {
        throw new DomainError("club_needs_administrators");
      }
      // The rows and the old single group (without a row: accepted as the participant role).
      const groupIds = [
        ...new Set([...groupRows.map((g) => g.groupId), data.groupId ?? []].flat()),
      ];
      const groups = await this.groups.findGroupsInTx(tx, groupIds);
      if (groups.length !== groupIds.length || groups.some((g) => g.clubId !== context.clubId)) {
        throw new DomainError("not_found");
      }
      if (groups.some((g) => g.archivedAt)) throw new DomainError("group_archived");
      const base = {
        clubId: context.clubId,
        kind: data.kind,
        groupId: data.groupId ?? null,
        rolePreset: data.rolePreset ?? null,
        clubRoleId: options.clubRoleId ?? null,
        expiresAt: new Date(Date.now() + data.expiresInDays * 86_400_000),
        createdByPersonId: me,
      };
      let invitation: repo.InvitationRow;
      let url: string | null = null;
      let code: string | null = null;
      if (data.kind === "email") {
        const id = uuidv7();
        const token = emailInvitationToken(this.tokenKey!, id);
        invitation = await repo.insertInvitation(tx, {
          ...base,
          id,
          email: data.email,
          maxUses: 1,
          tokenHash: hashInvitationSecret(token),
        });
        await outbox.publish(tx, "invitation.created", {
          invitationId: id,
          clubId: context.clubId,
        });
      } else if (data.kind === "link") {
        const token = randomInvitationToken();
        invitation = await repo.insertInvitation(tx, {
          ...base,
          maxUses: data.maxUses ?? null,
          tokenHash: hashInvitationSecret(token),
        });
        url = invitationUrl(this.webUrl, token);
      } else {
        // Codes are short: retry on the (unlikely) collision with another secret.
        for (let attempt = 0; ; attempt++) {
          code = randomInvitationCode();
          try {
            invitation = await savepoint(tx, () =>
              repo.insertInvitation(tx, {
                ...base,
                maxUses: data.maxUses ?? null,
                tokenHash: hashInvitationSecret(code!),
              }),
            );
            break;
          } catch (error) {
            if (attempt < 3 && isUniqueViolation(error, "invitations_token_unique")) continue;
            throw error;
          }
        }
      }
      await repo.insertInvitationGroups(tx, context.clubId, invitation.id, groupRows);
      await audit.record(tx, {
        action: "invitation.created",
        resourceType: "invitation",
        resourceId: invitation.id,
        changedFields: [
          "kind",
          "group_id",
          "role_preset",
          "club_role_id",
          "groups",
          "expires_at",
          "max_uses",
        ],
      });
      return { invitation: { ...invitation, groups: [...groupRows] }, url, code };
    });
  }

  /**
   * An email invitation to the club manager role for the club's second
   * administrator, made with the club (P1.15 A3): by its creator, without a
   * second factor (the creator is founding the club). Without
   * INVITATION_TOKEN_KEY nothing is sent (false); the club then invites from
   * its administrators page.
   */
  async createAdministratorInvitationInTx(
    tx: Tx,
    clubId: string,
    createdByPersonId: string,
    email: string,
  ): Promise<boolean> {
    if (!this.tokenKey) return false;
    const id = uuidv7();
    const token = emailInvitationToken(this.tokenKey, id);
    await repo.insertInvitation(tx, {
      id,
      clubId,
      kind: "email",
      groupId: null,
      rolePreset: "club_manager",
      expiresAt: new Date(Date.now() + ADMINISTRATOR_INVITATION_DAYS * 86_400_000),
      createdByPersonId,
      email,
      maxUses: 1,
      tokenHash: hashInvitationSecret(token),
    });
    await outbox.publish(tx, "invitation.created", { invitationId: id, clubId });
    await audit.record(tx, {
      action: "invitation.created",
      resourceType: "invitation",
      resourceId: id,
      changedFields: ["kind", "role_preset", "expires_at", "max_uses"],
    });
    return true;
  }

  /** The club's invitations; `ownOnly`: only the caller's (group owners, P1.15 A4). */
  list(
    context: TenantContext,
    page: { cursor?: string | undefined; limit: number },
    options: { ownOnly?: boolean } = {},
  ): Promise<{ items: Invitation[]; nextCursor: string | null }> {
    return this.db.withTenant(context, async (tx) => {
      const result = await repo.clubInvitationsPage(tx, context.clubId, {
        cursor: page.cursor ?? null,
        limit: page.limit + 1,
        createdBy: options.ownOnly ? actorPersonId(context) : undefined,
      });
      if (!result.cursorFound) throw new DomainError("invalid_cursor");
      const rows = result.items.slice(0, page.limit);
      const items = await this.withGroupsInTx(tx, rows);
      return { items, nextCursor: result.items.length > page.limit ? items.at(-1)!.id : null };
    });
  }

  /** The invitations with their group rows; older ones (no rows) show their one group. */
  private async withGroupsInTx(tx: Tx, rows: repo.InvitationRow[]): Promise<Invitation[]> {
    const groupRows = await repo.invitationGroupsOf(
      tx,
      rows.map((r) => r.id),
    );
    const byInvitation = new Map<string, repo.InvitationGroupRow[]>();
    for (const g of groupRows) {
      byInvitation.set(g.invitationId, [...(byInvitation.get(g.invitationId) ?? []), g]);
    }
    const legacy = rows.some((r) => r.groupId && !byInvitation.has(r.id))
      ? await this.clubRoles.rolesOfClubInTx(tx, rows[0]!.clubId)
      : [];
    const participant = legacy.find((r) => r.scope === "group" && r.templateKey === "member");
    return rows.map((r) => {
      const own = byInvitation.get(r.id);
      const groups = own
        ? own.map((g) => ({ groupId: g.groupId, roleId: g.roleId }))
        : r.groupId && participant
          ? [{ groupId: r.groupId, roleId: participant.id }]
          : [];
      return { ...r, groups };
    });
  }

  /** Revokes an invitation; `ownOnly`: only one the caller made (group owners, P1.15 A4). */
  revoke(
    context: TenantContext,
    invitationId: string,
    options: { ownOnly?: boolean } = {},
  ): Promise<void> {
    return this.db.withTenant(context, async (tx) => {
      const invitation = await repo.lockInvitation(tx, invitationId);
      if (!invitation) throw new DomainError("not_found");
      if (options.ownOnly && invitation.createdByPersonId !== actorPersonId(context)) {
        throw new DomainError("not_found");
      }
      if (invitation.revokedAt) return;
      await repo.revokeInvitation(tx, invitationId);
      await audit.record(tx, {
        action: "invitation.revoked",
        resourceType: "invitation",
        resourceId: invitationId,
        changedFields: ["revoked_at"],
      });
    });
  }

  /**
   * Which club a usable invitation is for, and the groups and club role it
   * gives (public: the landing page before login; P1.15 A4). Group names
   * and roles are read in the club's context once the secret matched.
   */
  async lookup(secret: InvitationSecret): Promise<{
    clubId: string;
    clubName: string;
    kind: "email" | "link" | "code";
    groups: { groupId: string; groupName: string; role: InvitationRole }[];
    clubRole: InvitationRole | null;
  }> {
    const found = await this.db.withActor({ actorKind: "anonymous" }, (tx) =>
      repo.findUsableInvitation(tx, secretHash(secret)),
    );
    if (!found) throw new DomainError("invitation_invalid");
    const details = await this.db.withSystem(
      "invitations:lookup",
      { clubId: found.clubId },
      async (tx) => {
        const invitation = await repo.findInvitation(tx, found.invitationId);
        if (!invitation) return { groups: [], clubRole: null };
        const [withGroups] = await this.withGroupsInTx(tx, [invitation]);
        const rows = withGroups!.groups;
        if (rows.length === 0 && !invitation.clubRoleId && !invitation.rolePreset) {
          return { groups: [], clubRole: null };
        }
        const [groups, roles] = await Promise.all([
          this.groups.findGroupsInTx(
            tx,
            rows.map((g) => g.groupId),
          ),
          this.clubRoles.rolesOfClubInTx(tx, found.clubId),
        ]);
        const groupById = new Map(groups.map((g) => [g.id, g]));
        const roleById = new Map(roles.map((r) => [r.id, r]));
        const clubRole = invitation.clubRoleId
          ? roleById.get(invitation.clubRoleId)
          : invitation.rolePreset
            ? roles.find((r) => r.scope === "club" && r.templateKey === invitation.rolePreset)
            : undefined;
        return {
          groups: rows.flatMap((g) => {
            const group = groupById.get(g.groupId);
            const role = roleById.get(g.roleId);
            return group && role && !group.archivedAt
              ? [{ groupId: group.id, groupName: group.name, role: roleView(role) }]
              : [];
          }),
          clubRole: clubRole ? roleView(clubRole) : null,
        };
      },
    );
    return { clubId: found.clubId, clubName: found.clubName, kind: found.kind, ...details };
  }

  /**
   * The logged-in person accepts. Email invitations need the account's
   * verified email to be the invited address. Idempotent per person: accepting
   * again (or as an existing member) changes nothing but the presets.
   */
  async accept(
    context: ActorContext,
    secret: InvitationSecret,
  ): Promise<{ clubId: string; clubName: string; alreadyMember: boolean }> {
    const me = actorPersonId(context);
    const tokenHash = secretHash(secret);
    const found = await this.db.withActor(context, async (tx) => {
      await this.accounts.requireReadyForClubsInTx(tx, me);
      return repo.findUsableInvitation(tx, tokenHash);
    });
    if (!found) throw new DomainError("invitation_invalid");
    if (found.kind === "email") {
      const account = await this.accounts.getOwnAccount(context);
      if (!account || account.email !== found.email) {
        throw new DomainError("invitation_email_mismatch");
      }
    }
    const clubContext: TenantContext = { ...context, clubId: found.clubId };
    return this.db.withTenant(clubContext, async (tx) => {
      await this.clubs.lockClubInTx(tx, found.clubId);
      const invitation = await repo.lockInvitation(tx, found.invitationId);
      if (!invitation || invitationState(invitation) !== "active") {
        throw new DomainError("invitation_invalid");
      }
      const alreadyMember = await this.memberships.hasOpenMembershipInTx(tx, found.clubId, me);
      const roles = await this.clubRoles.rolesOfClubInTx(tx, found.clubId);
      const clubRole = invitation.clubRoleId
        ? roles.find((r) => r.id === invitation.clubRoleId && r.scope === "club")
        : undefined;
      // An invitation to an administrator role brings an administrator:
      // allowed also when the club needs administrators (P1.15 A3).
      if (!alreadyMember)
        await this.memberships.addMemberInTx(tx, clubContext, me, undefined, {
          administrator:
            invitation.rolePreset === "club_manager" ||
            (clubRole?.permissions.includes("club.roles.manage") ?? false),
        });
      await this.joinRequests.settleByInvitationInTx(tx, found.clubId, me);
      const [withGroups] = await this.withGroupsInTx(tx, [invitation]);
      await this.applyPresetsInTx(tx, clubContext, withGroups!, clubRole, me);
      const first = await repo.insertAcceptance(tx, {
        clubId: found.clubId,
        invitationId: invitation.id,
        personId: me,
      });
      if (first) {
        await repo.countInvitationUse(
          tx,
          invitation.id,
          me,
          invitation.acceptedByPersonId === null,
        );
        await audit.record(tx, {
          action: "invitation.accepted",
          resourceType: "invitation",
          resourceId: invitation.id,
          changedFields: ["uses"],
        });
      }
      return { clubId: found.clubId, clubName: found.clubName, alreadyMember };
    });
  }

  /**
   * Adds the person to every group of the invitation with its role (archived
   * groups skipped, "already in the group" ignored) and gives the club role
   * (P1.15 A4), each step with its own audit event.
   */
  private async applyPresetsInTx(
    tx: Tx,
    context: TenantContext,
    invitation: Invitation,
    clubRole: ClubRoleRow | undefined,
    personId: string,
  ): Promise<void> {
    for (const row of invitation.groups) {
      try {
        await savepoint(tx, () =>
          this.memberships.addToGroupInTx(tx, context, row.groupId, personId, "member", {
            roleId: row.roleId,
          }),
        );
      } catch (error) {
        if (!isDomainError(error, "already_in_group") && !isDomainError(error, "group_archived")) {
          throw error;
        }
      }
    }
    try {
      if (invitation.rolePreset) {
        const role = invitation.rolePreset;
        await savepoint(tx, () => this.roles.assignRoleInTx(tx, context, personId, role));
      } else if (clubRole) {
        await savepoint(tx, () =>
          this.clubRoles.assignClubRoleInTx(tx, context, personId, clubRole.id, { invited: true }),
        );
      }
    } catch (error) {
      if (!isDomainError(error, "role_already_assigned")) throw error;
    }
  }
}

export interface InvitationRole {
  id: string;
  templateKey: string | null;
  names: Record<string, string> | null;
}

const roleView = (role: ClubRoleRow): InvitationRole => ({
  id: role.id,
  templateKey: role.templateKey,
  names: role.names,
});
