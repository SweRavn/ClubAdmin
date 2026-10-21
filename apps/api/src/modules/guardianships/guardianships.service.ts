// SPDX-License-Identifier: AGPL-3.0-only
// Guardianships (domain-model.md): parents and legal guardians have full
// rights by default, relatives and contact persons view-only rights granted by
// a guardian. Two full guardians cannot remove each other; only a club
// manager can (audited). Children are created without email.

import { createHash, randomBytes } from "node:crypto";

import { audit, type Database, isUniqueViolation, outbox, type Tx } from "@clubadmin/db";
import {
  type CreatePersonInput,
  DEFAULT_GUARDIANSHIP_RIGHTS,
  EmailSchema,
  type GuardianshipKind,
  GuardianshipKindSchema,
  type GuardianshipRight,
  GuardianshipRightsSchema,
} from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import {
  actorPersonId,
  type Context,
  hasClub,
  parseInput,
  runAs,
} from "../../platform/domain/run.ts";
import type { PeopleService, Person } from "../people/index.ts";
import * as repo from "./guardianships.repository.ts";

export type Guardianship = repo.GuardianshipRow;

export const GUARDIAN_INVITATION_VALID_DAYS = 14;

const FULL_KINDS: readonly GuardianshipKind[] = ["parent", "legal_guardian"];
const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest("base64url");

export class GuardianshipsService {
  private readonly db: Database;
  private readonly people: PeopleService;

  constructor(db: Database, people: PeopleService) {
    this.db = db;
    this.people = people;
  }

  /** "Add child": a new person without account or email, with the actor as parent. */
  addChild(
    context: Context,
    child: CreatePersonInput,
    kind: GuardianshipKind = "parent",
  ): Promise<{ child: Person; guardianship: Guardianship }> {
    return runAs(this.db, context, async (tx) => {
      const guardian = actorPersonId(context);
      parseInput(GuardianshipKindSchema, kind);
      const person = await this.people.createPersonInTx(tx, context, child);
      const guardianship = await this.insertInTx(
        tx,
        guardian,
        person.id,
        kind,
        DEFAULT_GUARDIANSHIP_RIGHTS[kind],
        guardian,
      );
      return { child: person, guardianship };
    });
  }

  /**
   * Adds a guardian to a ward. Relatives and contact persons need a full
   * guardian as actor; full guardians can also be confirmed by a club where
   * the ward is a member (e.g. from a paper application; RLS checks the ward).
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
      parseInput(GuardianshipKindSchema, input.kind);
      const rights = input.rights
        ? parseInput(GuardianshipRightsSchema, input.rights)
        : DEFAULT_GUARDIANSHIP_RIGHTS[input.kind];
      const isFullGuardian = await repo.actorIsFullGuardianOf(tx, input.wardPersonId);
      if (!FULL_KINDS.includes(input.kind) && !isFullGuardian) throw new DomainError("not_allowed");
      if (!isFullGuardian && !(hasClub(context) && (await repo.actorIsClubManager(tx)))) {
        throw new DomainError("not_allowed");
      }
      return this.insertInTx(
        tx,
        input.guardianPersonId,
        input.wardPersonId,
        input.kind,
        rights,
        context.personId ?? null,
      );
    });
  }

  /**
   * Invites a co-guardian by email (pending until accepted). Returns the
   * secret token for the invitation link; only its hash is stored.
   */
  inviteCoGuardian(
    context: Context,
    input: { wardPersonId: string; email: string; kind?: GuardianshipKind },
  ): Promise<{ invitationId: string; token: string }> {
    return runAs(this.db, context, async (tx) => {
      const actor = actorPersonId(context);
      const kind = parseInput(GuardianshipKindSchema, input.kind ?? "parent");
      const email = parseInput(EmailSchema, input.email);
      if (!(await repo.actorIsFullGuardianOf(tx, input.wardPersonId)))
        throw new DomainError("not_allowed");
      const token = randomBytes(32).toString("base64url");
      const invitation = await repo.insertInvitation(tx, {
        wardPersonId: input.wardPersonId,
        invitedByPersonId: actor,
        email,
        tokenHash: hashToken(token),
        kind,
        rights: [...DEFAULT_GUARDIANSHIP_RIGHTS[kind]],
        expiresAt: new Date(Date.now() + GUARDIAN_INVITATION_VALID_DAYS * 86_400_000),
      });
      await audit.record(tx, {
        action: "guardianship.invited",
        resourceType: "guardian_invitation",
        resourceId: invitation.id,
      });
      await outbox.publish(tx, "guardianship.invited", {
        invitationId: invitation.id,
        wardPersonId: input.wardPersonId,
      });
      return { invitationId: invitation.id, token };
    });
  }

  /** The invitee (acting as themselves) accepts with the token from the link. */
  acceptInvitation(context: Context, token: string): Promise<Guardianship> {
    return runAs(this.db, context, async (tx) => {
      const guardian = actorPersonId(context);
      const id = await repo.acceptInvitation(tx, hashToken(token));
      if (!id) throw new DomainError("invitation_invalid");
      const guardianship = await repo.findGuardianship(tx, id);
      if (!guardianship) throw new DomainError("invitation_invalid");
      await audit.record(tx, {
        action: "guardianship.created",
        resourceType: "guardianship",
        resourceId: id,
      });
      await outbox.publish(tx, "guardianship.changed", {
        guardianPersonId: guardian,
        wardPersonId: guardianship.wardPersonId,
      });
      return guardianship;
    });
  }

  /** Changes a relative's or contact person's rights; only a full guardian of the ward may. */
  updateRights(
    context: Context,
    guardianshipId: string,
    rights: GuardianshipRight[],
  ): Promise<Guardianship> {
    return runAs(this.db, context, async (tx) => {
      const parsed = parseInput(GuardianshipRightsSchema, rights);
      const guardianship = await repo.findGuardianship(tx, guardianshipId);
      if (!guardianship || guardianship.validTo) throw new DomainError("not_found");
      if (guardianship.guardianPersonId === context.personId) throw new DomainError("not_allowed");
      if (!(await repo.actorIsFullGuardianOf(tx, guardianship.wardPersonId)))
        throw new DomainError("not_allowed");
      await repo.updateGuardianship(tx, guardianshipId, { rights: parsed });
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
      return { ...guardianship, rights: parsed };
    });
  }

  /**
   * Ends a guardianship. A guardian can end their own, and full guardians can
   * end relatives' and contact persons'. Ending another full guardian needs a
   * club manager (`allowedBy: "club_manager"`, in the club's context).
   */
  endGuardianship(
    context: Context,
    guardianshipId: string,
    options: { allowedBy?: "club_manager" } = {},
  ): Promise<void> {
    return runAs(this.db, context, async (tx) => {
      const actor = actorPersonId(context);
      const guardianship = await repo.findGuardianship(tx, guardianshipId);
      if (!guardianship) throw new DomainError("not_found");
      if (guardianship.validTo) return;
      const own = guardianship.guardianPersonId === actor;
      const isFull = FULL_KINDS.includes(guardianship.kind);
      const allowed =
        own ||
        (!isFull && (await repo.actorIsFullGuardianOf(tx, guardianship.wardPersonId))) ||
        (options.allowedBy === "club_manager" &&
          hasClub(context) &&
          (await repo.actorIsClubManager(tx)));
      if (!allowed) throw new DomainError("not_allowed");
      await repo.updateGuardianship(tx, guardianshipId, { status: "ended", validTo: new Date() });
      await audit.record(tx, {
        action: "guardianship.ended",
        resourceType: "guardianship",
        resourceId: guardianshipId,
        changedFields: ["status", "valid_to"],
      });
      await outbox.publish(tx, "guardianship.changed", {
        guardianPersonId: guardianship.guardianPersonId,
        wardPersonId: guardianship.wardPersonId,
      });
    });
  }

  guardiansOf(context: Context, wardPersonId: string): Promise<Guardianship[]> {
    return runAs(this.db, context, (tx) => repo.guardiansOfQuery(tx, wardPersonId));
  }

  wardsOf(context: Context, guardianPersonId: string): Promise<Guardianship[]> {
    return runAs(this.db, context, (tx) => repo.wardsOfQuery(tx, guardianPersonId));
  }

  private async insertInTx(
    tx: Tx,
    guardianPersonId: string,
    wardPersonId: string,
    kind: GuardianshipKind,
    rights: readonly GuardianshipRight[],
    createdBy: string | null,
  ): Promise<Guardianship> {
    if (guardianPersonId === wardPersonId) throw new DomainError("invalid_input");
    let guardianship: Guardianship;
    try {
      guardianship = await repo.insertGuardianship(tx, {
        guardianPersonId,
        wardPersonId,
        kind,
        rights: [...rights],
        createdByPersonId: createdBy,
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
      changedFields: ["kind", "rights"],
    });
    await outbox.publish(tx, "guardianship.changed", { guardianPersonId, wardPersonId });
    return guardianship;
  }
}
