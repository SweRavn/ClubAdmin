// SPDX-License-Identifier: AGPL-3.0-only
// Clubs and their settings. Creating a club together with its first manager
// is done by the onboarding module (it needs memberships and roles).

import { getCountryPack, isSupportedCountry } from "@clubadmin/country-packs";
import {
  type ActorContext,
  audit,
  type Database,
  isUniqueViolation,
  type TenantContext,
  type Tx,
} from "@clubadmin/db";
import {
  type CreateClubInput,
  CreateClubSchema,
  type UpdateClubSettingsInput,
  UpdateClubSettingsSchema,
} from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { definedOnly, parseInput } from "../../platform/domain/run.ts";
import * as repo from "./clubs.repository.ts";

export type Club = repo.ClubRow;

export class ClubsService {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /** Inserts the club row; `tx` must be a tenant transaction for `clubId`. Defaults come from the country pack. */
  async insertClubInTx(tx: Tx, clubId: string, input: CreateClubInput): Promise<Club> {
    const data = parseInput(CreateClubSchema, input);
    if (!isSupportedCountry(data.country)) throw new DomainError("unsupported_country");
    const defaults = getCountryPack(data.country).localeDefaults;
    try {
      await repo.insertClub(tx, {
        id: clubId,
        name: data.name,
        shortName: data.shortName ?? null,
        slug: data.slug,
        country: data.country,
        defaultLocale: data.defaultLocale ?? defaults.locale,
        timeZone: data.timeZone ?? defaults.timeZone,
        currency: data.currency ?? defaults.currency,
        organizationNumber: data.organizationNumber ?? null,
        ...(data.joinPolicy ? { joinPolicy: data.joinPolicy } : {}),
      });
    } catch (error) {
      if (isUniqueViolation(error, "clubs_slug_unique")) throw new DomainError("club_slug_taken");
      throw error;
    }
    await audit.record(tx, { action: "club.created", resourceType: "club", resourceId: clubId });
    return this.getClubInTx(tx, clubId);
  }

  getClub(context: TenantContext): Promise<Club> {
    return this.db.withTenant(context, (tx) => this.getClubInTx(tx, context.clubId));
  }

  async getClubInTx(tx: Tx, clubId: string): Promise<Club> {
    const club = await repo.findClub(tx, clubId);
    if (!club) throw new DomainError("not_found");
    return club;
  }

  /** Clubs visible to the transaction (the current club, or clubs the actor or their wards belong to). */
  findClubsInTx(tx: Tx, clubIds: readonly string[]): Promise<Club[]> {
    return repo.findClubs(tx, clubIds);
  }

  /** Clubs the actor (or their ward) belongs to or holds a role in, by ID. */
  findClubs(context: ActorContext, clubIds: readonly string[]): Promise<Club[]> {
    return this.db.withActor(context, (tx) => repo.findClubs(tx, clubIds));
  }

  /** All clubs, without an actor (worker jobs and development tooling). */
  listAllSystem(jobName: string): Promise<Club[]> {
    return this.db.withSystem(jobName, {}, (tx) => repo.listClubs(tx));
  }

  /** Locks the club row until the end of the transaction. */
  async lockClubInTx(tx: Tx, clubId: string): Promise<Club> {
    const club = await repo.lockClub(tx, clubId);
    if (!club) throw new DomainError("not_found");
    return club;
  }

  updateSettings(context: TenantContext, patch: UpdateClubSettingsInput): Promise<Club> {
    return this.db.withTenant(context, async (tx) => {
      const data = definedOnly(parseInput(UpdateClubSettingsSchema, patch));
      const current = await this.lockClubInTx(tx, context.clubId);
      const changed = (Object.keys(data) as (keyof typeof data)[]).filter(
        (key) => JSON.stringify(data[key]) !== JSON.stringify(current[key]),
      );
      if (changed.length > 0) {
        await repo.updateClub(tx, context.clubId, data);
        await audit.record(tx, {
          action: "club.settings.updated",
          resourceType: "club",
          resourceId: context.clubId,
          changedFields: changed,
        });
      }
      return this.getClubInTx(tx, context.clubId);
    });
  }

  setJoinPolicy(context: TenantContext, joinPolicy: Club["joinPolicy"]): Promise<Club> {
    return this.updateSettings(context, { joinPolicy });
  }
}
