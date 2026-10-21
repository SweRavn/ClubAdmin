// SPDX-License-Identifier: AGPL-3.0-only
// What a club sees about a person (domain-model.md): member number, shared
// fields, emergency contacts, restricted notes and the club-level protected
// identity flag (ADR 0022). Created with the first membership.

import { audit, type Database, outbox, type TenantContext, type Tx } from "@clubadmin/db";
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

  /** The person's profile in the transaction's club, created (with a new member number) if missing. */
  async ensureProfileInTx(tx: Tx, context: TenantContext, personId: string): Promise<ClubProfile> {
    const existing = await repo.findProfile(tx, context.clubId, personId);
    if (existing) return existing;
    return repo.insertProfile(tx, context.clubId, personId);
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
