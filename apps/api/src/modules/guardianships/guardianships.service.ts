// SPDX-License-Identifier: AGPL-3.0-only
// Guardianships (domain-model.md): parents and legal guardians have full
// rights; relatives and contact persons only the rights chosen for them by a
// full guardian, by the ward themselves (adult, or from the consent age with
// their own login) or recorded by the club from a paper form (P1.3). Two
// full guardians cannot remove each other; only a club manager can, with a
// reason (audited, the reason never in the audit event). Children are
// created without email. A ward can have any number of guardians.

import { createHash } from "node:crypto";

import { ageOn } from "@clubadmin/country-packs";
import { audit, type Database, isUniqueViolation, outbox, type Tx } from "@clubadmin/db";
import { guardianInvitationToken } from "@clubadmin/server-kit/invitations";
import {
  type CreatePersonInput,
  DEFAULT_GUARDIANSHIP_RIGHTS,
  EmailSchema,
  type GuardianshipKind,
  GuardianshipKindSchema,
  type GuardianshipRight,
  GuardianshipRightsSchema,
  isFullGuardianshipKind,
  NewLinkedPersonSchema,
  SignUpPersonSchema,
  uuidv7,
  type z,
} from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import {
  actorPersonId,
  type Context,
  hasClub,
  parseInput,
  runAs,
} from "../../platform/domain/run.ts";
import type { AccountsService } from "../accounts/index.ts";
import type { MembershipsService } from "../memberships/index.ts";
import type { PeopleService, Person } from "../people/index.ts";
import * as repo from "./guardianships.repository.ts";

export type Guardianship = repo.GuardianshipRow;
export type GuardianInvitation = repo.GuardianInvitationRow;

export const GUARDIAN_INVITATION_VALID_DAYS = 14;

const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest("base64url");
const today = () => new Date().toISOString().slice(0, 10);

type NewLinkedPerson = z.input<typeof NewLinkedPersonSchema>;

/** Who is linking or changing a relative's or contact person's rights. */
type Granter = "full_guardian" | "adult_ward" | "young_ward" | "club";

/**
 * The rights a relative or contact person gets: the defaults, or the chosen
 * ones. Acting on behalf only for relatives, and only when a full guardian,
 * the adult ward or the club (paper form) chose it explicitly.
 */
function linkedRights(
  kind: GuardianshipKind,
  chosen: readonly GuardianshipRight[] | undefined,
  granter: Granter,
): GuardianshipRight[] {
  const rights = chosen
    ? [...new Set(parseInput(GuardianshipRightsSchema, chosen))]
    : [...DEFAULT_GUARDIANSHIP_RIGHTS[kind]];
  if (rights.includes("act_on_behalf") && (kind !== "relative" || granter === "young_ward")) {
    throw new DomainError("rights_not_allowed");
  }
  return rights;
}

/** The state of an invitation as its inviter and the ward's guardians see it. */
export function guardianInvitationPending(
  invitation: GuardianInvitation,
  now = new Date(),
): boolean {
  return (
    invitation.acceptedAt === null && invitation.revokedAt === null && invitation.expiresAt > now
  );
}

/** What the viewer of a ward's guardians may do (computed once per request). */
export interface WardViewer {
  /** Parent or legal guardian of the ward. */
  fullGuardian: boolean;
  /** The ward themselves. */
  ward: boolean;
  /** The ward may link and manage relatives and contact persons themselves. */
  wardMayLink: boolean;
  /** The ward is under the adult age (full guardians manage their links). */
  minor: boolean;
}

export class GuardianshipsService {
  private readonly db: Database;
  private readonly people: PeopleService;
  private readonly accounts: AccountsService;
  private readonly memberships: MembershipsService;
  private readonly tokenKey: string | undefined;

  constructor(
    db: Database,
    deps: {
      people: PeopleService;
      accounts: AccountsService;
      memberships: MembershipsService;
      /** INVITATION_TOKEN_KEY: invitation links are derived from it (the worker emails them). */
      tokenKey: string | undefined;
    },
  ) {
    this.db = db;
    this.people = deps.people;
    this.accounts = deps.accounts;
    this.memberships = deps.memberships;
    this.tokenKey = deps.tokenKey;
  }

  /** "Add child": a new person without account or email, with the actor as parent. `id`: fixed (demo seed). */
  addChild(
    context: Context,
    child: CreatePersonInput,
    kind: GuardianshipKind = "parent",
    options: { id?: string } = {},
  ): Promise<{ child: Person; guardianship: Guardianship }> {
    return runAs(this.db, context, async (tx) => {
      const guardian = actorPersonId(context);
      if (!isFullGuardianshipKind(parseInput(GuardianshipKindSchema, kind)))
        throw new DomainError("guardianship_kind_not_allowed");
      if (typeof child.birthDate === "string" && child.birthDate > today())
        throw new DomainError("birth_date_in_future");
      const person = await this.people.createPersonInTx(
        tx,
        context,
        child,
        options.id ? { id: options.id } : {},
      );
      const guardianship = await this.insertInTx(tx, {
        guardianPersonId: guardian,
        wardPersonId: person.id,
        kind,
        rights: DEFAULT_GUARDIANSHIP_RIGHTS[kind],
        createdBy: guardian,
      });
      return { child: person, guardianship };
    });
  }

  /**
   * Adds an existing person as guardian of a ward. Relatives and contact
   * persons need a full guardian as actor; full guardians can also be
   * confirmed by a club where the ward is a member (recordGuardian).
   */
  addGuardian(
    context: Context,
    input: {
      guardianPersonId: string;
      wardPersonId: string;
      kind: GuardianshipKind;
      rights?: GuardianshipRight[];
    },
  ): Promise<Guardianship> {
    return runAs(this.db, context, async (tx) => {
      const kind = parseInput(GuardianshipKindSchema, input.kind);
      const isFullGuardian = await repo.actorIsFullGuardianOf(tx, input.wardPersonId);
      if (!isFullGuardian) {
        if (
          !isFullGuardianshipKind(kind) ||
          !(hasClub(context) && (await repo.actorIsClubManager(tx)))
        )
          throw new DomainError("not_allowed");
      }
      const actor = actorPersonId(context);
      const linked = !isFullGuardianshipKind(kind);
      return this.insertInTx(tx, {
        guardianPersonId: input.guardianPersonId,
        wardPersonId: input.wardPersonId,
        kind,
        rights: linked
          ? linkedRights(kind, input.rights, "full_guardian")
          : DEFAULT_GUARDIANSHIP_RIGHTS[kind],
        createdBy: actor,
        grantedBy: linked ? actor : null,
      });
    });
  }

  /**
   * Invites a co-guardian, relative or contact person by email (pending
   * until accepted). Full guardians invite anyone for a minor; the ward
   * themselves (adult, or from the consent age) invites relatives and contact
   * persons. The link's token is derived from the invitation's ID with
   * INVITATION_TOKEN_KEY (the worker emails it); only its hash is stored.
   */
  inviteCoGuardian(
    context: Context,
    input: {
      wardPersonId: string;
      email: string;
      kind?: GuardianshipKind;
      rights?: readonly GuardianshipRight[] | undefined;
    },
  ): Promise<{ invitationId: string; token: string; expiresAt: Date }> {
    const key = this.tokenKey;
    if (!key) throw new DomainError("invitation_email_unavailable");
    return runAs(this.db, context, async (tx) => {
      const actor = actorPersonId(context);
      const kind = parseInput(GuardianshipKindSchema, input.kind ?? "parent");
      const email = parseInput(EmailSchema, input.email);
      const granter = await this.granterInTx(tx, actor, input.wardPersonId, kind);
      const rights = isFullGuardianshipKind(kind)
        ? [...DEFAULT_GUARDIANSHIP_RIGHTS[kind]]
        : linkedRights(kind, input.rights, granter);
      const id = uuidv7();
      const token = guardianInvitationToken(key, id, null);
      const expiresAt = new Date(Date.now() + GUARDIAN_INVITATION_VALID_DAYS * 86_400_000);
      await repo.insertInvitation(tx, {
        id,
        wardPersonId: input.wardPersonId,
        invitedByPersonId: actor,
        email,
        tokenHash: hashToken(token),
        kind,
        rights,
        expiresAt,
      });
      await audit.record(tx, {
        action: "guardianship.invited",
        resourceType: "guardian_invitation",
        resourceId: id,
        changedFields: ["kind", "rights"],
      });
      await outbox.publish(tx, "guardianship.invited", {
        invitationId: id,
        wardPersonId: input.wardPersonId,
      });
      return { invitationId: id, token, expiresAt };
    });
  }

  /**
   * Links a relative or contact person without login (name and phone) to a
   * ward, by a full guardian or the ward themselves. The new person is
   * reachable by the ward's family (and the ward's clubs).
   */
  addLinkedPerson(
    context: Context,
    input: {
      wardPersonId: string;
      person: NewLinkedPerson;
      kind: GuardianshipKind;
      rights?: readonly GuardianshipRight[] | undefined;
    },
    options: { id?: string } = {},
  ): Promise<{ person: Person; guardianship: Guardianship }> {
    return runAs(this.db, context, async (tx) => {
      const actor = actorPersonId(context);
      const kind = parseInput(GuardianshipKindSchema, input.kind);
      if (isFullGuardianshipKind(kind)) throw new DomainError("guardianship_kind_not_allowed");
      const granter = await this.granterInTx(tx, actor, input.wardPersonId, kind);
      const rights = linkedRights(kind, input.rights, granter);
      const person = await this.createLinkedPersonInTx(tx, context, input.person, options.id);
      const guardianship = await this.insertInTx(tx, {
        guardianPersonId: person.id,
        wardPersonId: input.wardPersonId,
        kind,
        rights,
        createdBy: actor,
        grantedBy: actor,
      });
      return { person, guardianship };
    });
  }

  /** Resend: a new link (the old one stops working) and a new expiry. */
  resendInvitation(context: Context, invitationId: string): Promise<GuardianInvitation> {
    const key = this.tokenKey;
    if (!key) throw new DomainError("invitation_email_unavailable");
    return runAs(this.db, context, async (tx) => {
      const invitation = await this.manageableInvitationInTx(tx, context, invitationId);
      if (invitation.acceptedAt || invitation.revokedAt)
        throw new DomainError("invitation_not_pending");
      const resentAt = new Date();
      const expiresAt = new Date(resentAt.getTime() + GUARDIAN_INVITATION_VALID_DAYS * 86_400_000);
      const tokenHash = hashToken(guardianInvitationToken(key, invitationId, resentAt));
      await repo.updateInvitation(tx, invitationId, { resentAt, expiresAt, tokenHash });
      await audit.record(tx, {
        action: "guardianship.invitation.resent",
        resourceType: "guardian_invitation",
        resourceId: invitationId,
        changedFields: ["resent_at", "expires_at", "token_hash"],
      });
      await outbox.publish(tx, "guardianship.invited", {
        invitationId,
        wardPersonId: invitation.wardPersonId,
      });
      return { ...invitation, resentAt, expiresAt, tokenHash };
    });
  }

  revokeInvitation(context: Context, invitationId: string): Promise<void> {
    return runAs(this.db, context, async (tx) => {
      const invitation = await this.manageableInvitationInTx(tx, context, invitationId);
      if (invitation.acceptedAt) throw new DomainError("invitation_not_pending");
      if (invitation.revokedAt) return;
      await repo.updateInvitation(tx, invitationId, { revokedAt: new Date() });
      await audit.record(tx, {
        action: "guardianship.invitation.revoked",
        resourceType: "guardian_invitation",
        resourceId: invitationId,
        changedFields: ["revoked_at"],
      });
    });
  }

  /**
   * The landing page of a link: the invitation if it is valid, else null
   * (unknown, expired, revoked and used ones look the same). Read without an
   * actor: the holder is not related to the ward yet; the token is the proof.
   */
  lookupInvitation(token: string): Promise<GuardianInvitation | null> {
    return this.db.withSystem("guardianships:invitation_lookup", {}, async (tx) => {
      const invitation = await repo.findInvitationByTokenHash(tx, hashToken(token));
      return invitation && guardianInvitationPending(invitation) ? invitation : null;
    });
  }

  /**
   * The invitee (acting as themselves) accepts with the token from the link.
   * Their verified login email must be the address the invitation was sent to.
   */
  acceptInvitation(context: Context, token: string): Promise<Guardianship> {
    return runAs(this.db, context, async (tx) => {
      const guardian = actorPersonId(context);
      const account = await this.accounts.ownAccountInTx(tx, guardian);
      if (!account) throw new DomainError("invitation_invalid");
      const result = await repo.acceptInvitation(tx, hashToken(token), account.email);
      if (result.status === "email_mismatch") throw new DomainError("invitation_email_mismatch");
      if (result.status === "exists") throw new DomainError("guardianship_exists");
      if (result.status !== "accepted" || !result.guardianshipId)
        throw new DomainError("invitation_invalid");
      const guardianship = await repo.findGuardianship(tx, result.guardianshipId);
      const invitationId = await repo.invitationOfGuardianship(tx, result.guardianshipId);
      if (!guardianship || !invitationId) throw new DomainError("invitation_invalid");
      await audit.record(tx, {
        action: "guardianship.invitation.accepted",
        resourceType: "guardian_invitation",
        resourceId: invitationId,
        changedFields: ["accepted_at"],
      });
      await audit.record(tx, {
        action: "guardianship.created",
        resourceType: "guardianship",
        resourceId: guardianship.id,
        changedFields: ["kind", "rights"],
      });
      await outbox.publish(tx, "guardianship.changed", {
        guardianPersonId: guardian,
        wardPersonId: guardianship.wardPersonId,
      });
      await outbox.publish(tx, "guardianship.invitation.accepted", {
        invitationId,
        wardPersonId: guardianship.wardPersonId,
      });
      return guardianship;
    });
  }

  /**
   * Changes a relative's or contact person's rights: a full guardian of a
   * minor ward, or the ward themselves (adult, or from the consent age).
   * Never the linked person, never a full guardian's rights.
   */
  updateRights(
    context: Context,
    guardianshipId: string,
    rights: GuardianshipRight[],
  ): Promise<Guardianship> {
    return runAs(this.db, context, async (tx) => {
      const actor = actorPersonId(context);
      const guardianship = await repo.findGuardianship(tx, guardianshipId);
      if (!guardianship || guardianship.validTo) throw new DomainError("not_found");
      if (guardianship.guardianPersonId === actor) throw new DomainError("not_allowed");
      if (isFullGuardianshipKind(guardianship.kind)) throw new DomainError("rights_not_allowed");
      const granter = await this.granterInTx(
        tx,
        actor,
        guardianship.wardPersonId,
        guardianship.kind,
      );
      const parsed = linkedRights(guardianship.kind, rights, granter);
      await repo.updateGuardianship(tx, guardianshipId, {
        rights: parsed,
        grantedByPersonId: actor,
      });
      await audit.record(tx, {
        action: "guardianship.updated",
        resourceType: "guardianship",
        resourceId: guardianshipId,
        changedFields: ["rights"],
      });
      await outbox.publish(tx, "guardianship.changed", {
        guardianPersonId: guardianship.guardianPersonId,
        wardPersonId: guardianship.wardPersonId,
      });
      return { ...guardianship, rights: parsed, grantedByPersonId: actor };
    });
  }

  /**
   * Ends a guardianship. Anyone can end their own. Relatives' and contact
   * persons' links: a full guardian of a minor ward, the ward themselves
   * (adult, or from the consent age), or the club that recorded them
   * (`allowedBy: "club"`). Another full guardian: only a club manager
   * (`allowedBy: "club_manager"`, in the club's context; the controller
   * requires a second factor) with a reason. A young person ends a full
   * guardian's access only with the adult decision.
   */
  endGuardianship(
    context: Context,
    guardianshipId: string,
    options: { allowedBy?: "club_manager" | "club"; reason?: string } = {},
  ): Promise<void> {
    return runAs(this.db, context, async (tx) => {
      const actor = actorPersonId(context);
      const guardianship = await repo.findGuardianship(tx, guardianshipId);
      if (!guardianship) throw new DomainError("not_found");
      if (guardianship.validTo) return;
      const own = guardianship.guardianPersonId === actor;
      const isFull = isFullGuardianshipKind(guardianship.kind);
      let reason: string | null = null;
      if (!own) {
        if (options.allowedBy === "club" && isFull) {
          // Full guardians only by a club manager with a second factor (allowedBy "club_manager").
          throw new DomainError(
            hasClub(context) && (await repo.actorIsClubManager(tx))
              ? "mfa_required"
              : "not_allowed",
          );
        }
        if (options.allowedBy === "club_manager") {
          if (!hasClub(context) || !(await repo.actorIsClubManager(tx)))
            throw new DomainError("not_allowed");
          if (
            !(await this.memberships.hasOpenMembershipInTx(
              tx,
              context.clubId,
              guardianship.wardPersonId,
            ))
          )
            throw new DomainError("not_found");
          if (isFull) {
            reason = options.reason?.trim() || null;
            if (!reason) throw new DomainError("reason_required");
          }
        } else if (options.allowedBy === "club") {
          if (
            !hasClub(context) ||
            guardianship.recordedByClubId !== context.clubId ||
            !(await repo.actorHasClubRole(tx, ["club_manager", "registrar"]))
          ) {
            throw new DomainError("not_allowed");
          }
        } else if (isFull) {
          throw new DomainError("not_allowed");
        } else {
          await this.granterInTx(tx, actor, guardianship.wardPersonId, guardianship.kind);
        }
      }
      await repo.updateGuardianship(tx, guardianshipId, {
        status: "ended",
        validTo: new Date(),
        ...(reason ? { endedReason: reason } : {}),
      });
      await audit.record(tx, {
        action: "guardianship.ended",
        resourceType: "guardianship",
        resourceId: guardianshipId,
        // That a reason exists, never its text.
        changedFields: reason ? ["status", "valid_to", "ended_reason"] : ["status", "valid_to"],
      });
      await outbox.publish(tx, "guardianship.changed", {
        guardianPersonId: guardianship.guardianPersonId,
        wardPersonId: guardianship.wardPersonId,
      });
    });
  }

  /**
   * A club records a guardianship from a paper application or form: an
   * existing person (a member of the club) or a new person without login.
   * Relatives and contact persons need a consent note; the club may end the
   * links it recorded.
   */
  recordGuardian(
    context: Context,
    input: {
      wardPersonId: string;
      guardian: { personId: string } | { person: NewLinkedPerson };
      kind: GuardianshipKind;
      rights?: readonly GuardianshipRight[] | undefined;
      consentNote?: string | undefined;
    },
    /** `id`: fixed ID of a new person (demo seed). */
    options: { id?: string } = {},
  ): Promise<{ guardianship: Guardianship; personId: string }> {
    return runAs(this.db, context, async (tx) => {
      if (!hasClub(context)) throw new DomainError("not_allowed");
      const actor = actorPersonId(context);
      const kind = parseInput(GuardianshipKindSchema, input.kind);
      if (!(await repo.actorHasClubRole(tx, ["club_manager", "registrar"])))
        throw new DomainError("not_allowed");
      if (!(await this.memberships.hasOpenMembershipInTx(tx, context.clubId, input.wardPersonId)))
        throw new DomainError("not_found");
      const linked = !isFullGuardianshipKind(kind);
      const consentNote = input.consentNote?.trim() || null;
      if (linked && !consentNote) throw new DomainError("invalid_input");
      if (!linked && (consentNote || input.rights)) throw new DomainError("invalid_input");
      let personId: string;
      if ("personId" in input.guardian) {
        // From the register: only the club's own members.
        if (
          !(await this.memberships.hasOpenMembershipInTx(
            tx,
            context.clubId,
            input.guardian.personId,
          ))
        )
          throw new DomainError("not_found");
        personId = input.guardian.personId;
      } else {
        personId = (
          await this.createLinkedPersonInTx(tx, context, input.guardian.person, options.id)
        ).id;
      }
      const guardianship = await this.insertInTx(tx, {
        guardianPersonId: personId,
        wardPersonId: input.wardPersonId,
        kind,
        rights: linked
          ? linkedRights(kind, input.rights, "club")
          : DEFAULT_GUARDIANSHIP_RIGHTS[kind],
        createdBy: actor,
        grantedBy: linked ? actor : null,
        recordedByClubId: context.clubId,
        consentNote,
      });
      return { guardianship, personId };
    });
  }

  /** A member's open guardianships as the club sees them (club administrators). */
  clubGuardians(context: Context, wardPersonId: string): Promise<Guardianship[]> {
    return runAs(this.db, context, async (tx) => {
      if (
        !hasClub(context) ||
        !(await this.memberships.hasOpenMembershipInTx(tx, context.clubId, wardPersonId))
      ) {
        throw new DomainError("not_found");
      }
      return repo.guardiansOfQuery(tx, wardPersonId);
    });
  }

  /** Open guardianships of a ward, oldest first. */
  guardiansOf(context: Context, wardPersonId: string): Promise<Guardianship[]> {
    return runAs(this.db, context, (tx) => repo.guardiansOfQuery(tx, wardPersonId));
  }

  wardsOf(context: Context, guardianPersonId: string): Promise<Guardianship[]> {
    return runAs(this.db, context, (tx) => repo.wardsOfQuery(tx, guardianPersonId));
  }

  /**
   * A ward's guardians and pending invitations, with what the acting person
   * may do (GET /me/wards/:personId/guardians). The policy already checked
   * that the actor is the ward or one of their guardians.
   */
  wardGuardians(
    context: Context,
    wardPersonId: string,
  ): Promise<{
    guardianships: Guardianship[];
    invitations: GuardianInvitation[];
    viewer: WardViewer;
  }> {
    return runAs(this.db, context, async (tx) => {
      const actor = actorPersonId(context);
      const [guardianships, invitations, viewer] = await Promise.all([
        repo.guardiansOfQuery(tx, wardPersonId),
        repo.pendingInvitationsOf(tx, wardPersonId),
        this.viewerInTx(tx, actor, wardPersonId),
      ]);
      return { guardianships, invitations, viewer };
    });
  }

  /** The relatives and contact persons linked to the acting person, and their pending invitations. */
  trustedPeople(context: Context): Promise<{
    guardianships: Guardianship[];
    invitations: GuardianInvitation[];
    viewer: WardViewer;
  }> {
    return runAs(this.db, context, async (tx) => {
      const me = actorPersonId(context);
      const [all, invitations, viewer] = await Promise.all([
        repo.guardiansOfQuery(tx, me),
        repo.pendingInvitationsOf(tx, me),
        this.viewerInTx(tx, me, me),
      ]);
      return {
        guardianships: all.filter((g) => !isFullGuardianshipKind(g.kind)),
        invitations: invitations.filter((i) => !isFullGuardianshipKind(i.kind)),
        viewer,
      };
    });
  }

  /** The young person's open guardianships flagged at the adult age, with their decision so far. */
  adultGuardians(context: Context): Promise<Guardianship[]> {
    return runAs(this.db, context, (tx) => repo.adultFlaggedOf(tx, actorPersonId(context)));
  }

  /**
   * The young person's decision at the adult age: keep or end this guardian's
   * access. Only the ward, only after the flag, once.
   */
  decideAdult(
    context: Context,
    guardianshipId: string,
    decision: "keep" | "end",
  ): Promise<Guardianship> {
    return runAs(this.db, context, async (tx) => {
      const me = actorPersonId(context);
      const guardianship = await repo.findGuardianship(tx, guardianshipId);
      if (!guardianship || guardianship.wardPersonId !== me) throw new DomainError("not_found");
      if (!guardianship.wardAdultFlaggedAt || guardianship.adultDecision || guardianship.validTo)
        throw new DomainError("adult_decision_not_open");
      const now = new Date();
      const values =
        decision === "keep"
          ? { adultDecision: "kept" as const, adultDecidedAt: now }
          : {
              adultDecision: "ended" as const,
              adultDecidedAt: now,
              status: "ended" as const,
              validTo: now,
            };
      await repo.updateGuardianship(tx, guardianshipId, values);
      await audit.record(tx, {
        action: "guardianship.adult.decided",
        resourceType: "guardianship",
        resourceId: guardianshipId,
        changedFields:
          decision === "keep"
            ? ["adult_decision", "adult_decided_at"]
            : ["adult_decision", "adult_decided_at", "status", "valid_to"],
      });
      if (decision === "end") {
        await outbox.publish(tx, "guardianship.changed", {
          guardianPersonId: guardianship.guardianPersonId,
          wardPersonId: me,
        });
        await outbox.publish(tx, "guardianship.adult.ended", {
          guardianshipId,
          wardPersonId: me,
        });
      }
      return { ...guardianship, ...values };
    });
  }

  /**
   * How the actor stands to a ward. Relatives and contact persons may be
   * linked by a full guardian while the ward is under the adult age, by the
   * ward themselves from the consent age (with their own login, which the
   * caller has) and acting for them only from the adult age.
   */
  private async viewerInTx(tx: Tx, actor: string, wardPersonId: string): Promise<WardViewer> {
    const ward = actor === wardPersonId;
    const [fullGuardian, person] = await Promise.all([
      ward ? Promise.resolve(false) : repo.actorIsFullGuardianOf(tx, wardPersonId),
      this.people.getPersonInTx(tx, wardPersonId),
    ]);
    const rules = await this.accounts.ageRulesInTx(tx, wardPersonId);
    const age = person.birthDate ? ageOn(person.birthDate) : null;
    return {
      fullGuardian,
      ward,
      wardMayLink: ward && age !== null && age >= rules.consentAge,
      // Unknown age: treated as a minor for guardians' rights over their child.
      minor: age === null || age < rules.adultAge,
    };
  }

  /** Who links or changes a relative's or contact person's rights; throws if nobody may. */
  private async granterInTx(
    tx: Tx,
    actor: string,
    wardPersonId: string,
    kind: GuardianshipKind,
  ): Promise<Granter> {
    // Nobody else learns whether the ward exists.
    if (actor !== wardPersonId && !(await repo.actorIsFullGuardianOf(tx, wardPersonId)))
      throw new DomainError("not_allowed");
    const viewer = await this.viewerInTx(tx, actor, wardPersonId);
    if (viewer.fullGuardian) {
      // Full guardians invite co-guardians at any age; relatives only for a minor.
      if (isFullGuardianshipKind(kind) || viewer.minor) return "full_guardian";
      throw new DomainError("not_allowed");
    }
    if (viewer.ward) {
      if (isFullGuardianshipKind(kind)) throw new DomainError("guardianship_kind_not_allowed");
      if (!viewer.wardMayLink) throw new DomainError("too_young_to_link");
      return viewer.minor ? "young_ward" : "adult_ward";
    }
    throw new DomainError("not_allowed");
  }

  /** The inviter, a full guardian of the ward, or the ward for their own invitations. */
  private async manageableInvitationInTx(
    tx: Tx,
    context: Context,
    invitationId: string,
  ): Promise<GuardianInvitation> {
    const actor = actorPersonId(context);
    const invitation = await repo.lockInvitation(tx, invitationId);
    if (!invitation) throw new DomainError("not_found");
    const allowed =
      invitation.invitedByPersonId === actor ||
      (await repo.actorIsFullGuardianOf(tx, invitation.wardPersonId)) ||
      (invitation.wardPersonId === actor && !isFullGuardianshipKind(invitation.kind));
    if (!allowed) throw new DomainError("not_allowed");
    return invitation;
  }

  private createLinkedPersonInTx(
    tx: Tx,
    context: Context,
    input: NewLinkedPerson,
    id?: string,
  ): Promise<Person> {
    const person = parseInput(NewLinkedPersonSchema, input);
    return this.people.createPersonInTx(
      tx,
      context,
      { ...person, birthDate: null },
      { schema: SignUpPersonSchema, ...(id ? { id } : {}) },
    );
  }

  private async insertInTx(
    tx: Tx,
    values: {
      guardianPersonId: string;
      wardPersonId: string;
      kind: GuardianshipKind;
      rights: readonly GuardianshipRight[];
      createdBy: string | null;
      grantedBy?: string | null;
      recordedByClubId?: string | null;
      consentNote?: string | null;
    },
  ): Promise<Guardianship> {
    const { guardianPersonId, wardPersonId } = values;
    if (guardianPersonId === wardPersonId) throw new DomainError("invalid_input");
    let guardianship: Guardianship;
    try {
      guardianship = await repo.insertGuardianship(tx, {
        guardianPersonId,
        wardPersonId,
        kind: values.kind,
        rights: [...values.rights],
        createdByPersonId: values.createdBy,
        grantedByPersonId: values.grantedBy ?? null,
        recordedByClubId: values.recordedByClubId ?? null,
        consentNote: values.consentNote ?? null,
      });
    } catch (error) {
      if (isUniqueViolation(error, "guardianships_open_unique"))
        throw new DomainError("guardianship_exists");
      throw error;
    }
    await audit.record(tx, {
      action: "guardianship.created",
      resourceType: "guardianship",
      resourceId: guardianship.id,
      changedFields: [
        "kind",
        "rights",
        ...(values.recordedByClubId ? ["recorded_by_club_id"] : []),
        ...(values.consentNote ? ["consent_note"] : []),
      ],
    });
    await outbox.publish(tx, "guardianship.changed", { guardianPersonId, wardPersonId });
    return guardianship;
  }
}
