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
import type {
  INVITATION_STATES} from "@clubadmin/shared";
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
import type { RolesService } from "../roles/index.ts";
import type { JoinRequestsService } from "./join-requests.service.ts";
import * as repo from "./joining.repository.ts";

export type Invitation = repo.InvitationRow;
export type InvitationState = (typeof INVITATION_STATES)[number];

export function invitationState(invitation: Invitation, now = new Date()): InvitationState {
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

export class InvitationsService {
  private readonly db: Database;
  private readonly clubs: ClubsService;
  private readonly groups: GroupsService;
  private readonly memberships: MembershipsService;
  private readonly roles: RolesService;
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
    this.accounts = deps.accounts;
    this.joinRequests = deps.joinRequests;
    this.tokenKey = deps.tokenKey;
    this.webUrl = deps.webUrl;
  }

  /**
   * Creates an invitation and returns its link or code once. `mayPresetRole`:
   * the caller holds club.roles.manage (authorization decides).
   */
  create(
    context: TenantContext,
    input: CreateInvitationInput,
    options: { mayPresetRole: boolean },
  ): Promise<{ invitation: Invitation; url: string | null; code: string | null }> {
    const data = parseInput(CreateInvitationSchema, input);
    const me = actorPersonId(context);
    if (data.rolePreset && !options.mayPresetRole) throw new DomainError("role_preset_not_allowed");
    if (data.kind === "email" && !this.tokenKey) {
      throw new DomainError("invitation_email_unavailable");
    }
    return this.db.withTenant(context, async (tx) => {
      if (data.groupId) {
        const group = await this.groups.getGroupInTx(tx, data.groupId);
        if (group.archivedAt) throw new DomainError("group_archived");
      }
      const base = {
        clubId: context.clubId,
        kind: data.kind,
        groupId: data.groupId ?? null,
        rolePreset: data.rolePreset ?? null,
        expiresAt: new Date(Date.now() + data.expiresInDays * 86_400_000),
        createdByPersonId: me,
      };
      let invitation: Invitation;
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
      await audit.record(tx, {
        action: "invitation.created",
        resourceType: "invitation",
        resourceId: invitation.id,
        changedFields: ["kind", "group_id", "role_preset", "expires_at", "max_uses"],
      });
      return { invitation, url, code };
    });
  }

  list(
    context: TenantContext,
    page: { cursor?: string | undefined; limit: number },
  ): Promise<{ items: Invitation[]; nextCursor: string | null }> {
    return this.db.withTenant(context, async (tx) => {
      const result = await repo.clubInvitationsPage(tx, context.clubId, {
        cursor: page.cursor ?? null,
        limit: page.limit + 1,
      });
      if (!result.cursorFound) throw new DomainError("invalid_cursor");
      const items = result.items.slice(0, page.limit);
      return { items, nextCursor: result.items.length > page.limit ? items.at(-1)!.id : null };
    });
  }

  revoke(context: TenantContext, invitationId: string): Promise<void> {
    return this.db.withTenant(context, async (tx) => {
      const invitation = await repo.lockInvitation(tx, invitationId);
      if (!invitation) throw new DomainError("not_found");
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

  /** Which club a usable invitation is for (public: the landing page before login). */
  async lookup(
    secret: InvitationSecret,
  ): Promise<{ clubId: string; clubName: string; kind: "email" | "link" | "code" }> {
    const found = await this.db.withActor({ actorKind: "anonymous" }, (tx) =>
      repo.findUsableInvitation(tx, secretHash(secret)),
    );
    if (!found) throw new DomainError("invitation_invalid");
    return { clubId: found.clubId, clubName: found.clubName, kind: found.kind };
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
      if (!alreadyMember) await this.memberships.addMemberInTx(tx, clubContext, me);
      await this.joinRequests.settleByInvitationInTx(tx, found.clubId, me);
      await this.applyPresetsInTx(tx, clubContext, invitation, me);
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

  private async applyPresetsInTx(
    tx: Tx,
    context: TenantContext,
    invitation: Invitation,
    personId: string,
  ): Promise<void> {
    try {
      if (invitation.groupId) {
        const groupId = invitation.groupId;
        await savepoint(tx, () => this.memberships.addToGroupInTx(tx, context, groupId, personId));
      }
    } catch (error) {
      if (!isDomainError(error, "already_in_group") && !isDomainError(error, "group_archived")) {
        throw error;
      }
    }
    try {
      if (invitation.rolePreset) {
        const role = invitation.rolePreset;
        await savepoint(tx, () => this.roles.assignRoleInTx(tx, context, personId, role));
      }
    } catch (error) {
      if (!isDomainError(error, "role_already_assigned")) throw error;
    }
  }
}
