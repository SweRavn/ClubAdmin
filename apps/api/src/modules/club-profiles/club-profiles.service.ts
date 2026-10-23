// SPDX-License-Identifier: AGPL-3.0-only
// What a club sees about a person (domain-model.md): member number, shared
// fields, emergency contacts, restricted notes and the club-level protected
// identity flag (ADR 0022). Created with the first membership.

import {
  audit,
  type Database,
  isUniqueViolation,
  outbox,
  type TenantContext,
  type Tx,
} from "@clubadmin/db";
import { type UpdateClubProfileInput, UpdateClubProfileSchema } from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { definedOnly, parseInput } from "../../platform/domain/run.ts";
import * as repo from "./club-profiles.repository.ts";

export type ClubProfile = repo.ClubProfileRow;

export class ClubProfilesService {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * The person's profile in the transaction's club, created (with a new
   * member number, or the kept one in `init`) if missing.
   */
  async ensureProfileInTx(
    tx: Tx,
    context: TenantContext,
    personId: string,
    init: repo.ProfileInit = {},
    /** `isNew`: the person was created in this transaction (no profile yet). */
    options: { isNew?: boolean } = {},
  ): Promise<ClubProfile> {
    const existing = options.isNew ? null : await repo.findProfile(tx, context.clubId, personId);
    if (existing) return existing;
    try {
      return await repo.insertProfile(tx, context.clubId, personId, init);
    } catch (error) {
      if (isUniqueViolation(error, "club_profiles_member_number_unique"))
        throw new DomainError("member_number_taken");
      throw error;
    }
  }

  /**
   * Reserves `count` running member numbers in their own short transaction
   * (imports, P1.3b): the first one is returned. Profiles inserted with them
   * do not lock the club's counter, so concurrent import batches do not wait
   * for each other. Numbers of a batch that is rolled back stay unused.
   */
  reserveMemberNumbers(context: TenantContext, count: number): Promise<number> {
    return this.db.withTenant(context, (tx) =>
      repo.reserveMemberNumbers(tx, context.clubId, count),
    );
  }

  /** Which of these member numbers are taken in the transaction's club. */
  takenMemberNumbersInTx(tx: Tx, clubId: string, numbers: readonly number[]): Promise<Set<number>> {
    return repo.takenMemberNumbers(tx, clubId, numbers);
  }

  async hasProfileInTx(tx: Tx, clubId: string, personId: string): Promise<boolean> {
    return (await repo.findProfile(tx, clubId, personId)) !== null;
  }

  getProfile(context: TenantContext, personId: string): Promise<ClubProfile> {
    return this.db.withTenant(context, async (tx) => {
      const profile = await repo.findProfile(tx, context.clubId, personId);
      if (!profile) throw new DomainError("not_found");
      return profile;
    });
  }

  updateProfile(
    context: TenantContext,
    personId: string,
    patch: UpdateClubProfileInput,
  ): Promise<ClubProfile> {
    return this.db.withTenant(context, async (tx) => {
      const data = parseInput(UpdateClubProfileSchema, patch);
      const profile = await repo.findProfile(tx, context.clubId, personId);
      if (!profile) throw new DomainError("not_found");
      const changed = Object.keys(data);
      if (changed.length > 0) {
        await repo.updateProfile(tx, profile.id, definedOnly(data));
        await audit.record(tx, {
          action: "club.profile.updated",
          resourceType: "club_profile",
          resourceId: profile.id,
          changedFields: changed,
        });
      }
      return (await repo.findProfile(tx, context.clubId, personId))!;
    });
  }

  /** Club-level protected identity (ADR 0022): club managers only, audited. */
  setClubProtection(
    context: TenantContext,
    personId: string,
    value: boolean,
  ): Promise<ClubProfile> {
    return this.db.withTenant(context, async (tx) => {
      if (!(await repo.actorIsClubManager(tx))) throw new DomainError("not_a_club_manager");
      const profile = await repo.findProfile(tx, context.clubId, personId);
      if (!profile) throw new DomainError("not_found");
      if (profile.protectedIdentityClub !== value) {
        await repo.updateProfile(tx, profile.id, { protectedIdentityClub: value });
        await audit.record(tx, {
          action: "person.protection.changed",
          resourceType: "club_profile",
          resourceId: profile.id,
          changedFields: ["protected_identity_club"],
        });
        await outbox.publish(tx, "person.protection.changed", { personId, clubId: context.clubId });
      }
      return { ...profile, protectedIdentityClub: value };
    });
  }
}
