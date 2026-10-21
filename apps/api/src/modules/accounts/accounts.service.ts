// SPDX-License-Identifier: AGPL-3.0-only
// Login accounts (ADR 0020): one per person, the only place an email lives,
// unique case-insensitively across the system. Rows are visible only to their
// own person, so duplicates are detected by the unique index, never by
// looking up other people's accounts.

import { ageOn, getCountryPack, isSupportedCountry } from "@clubadmin/country-packs";
import {
  type ActorContext,
  audit,
  type Database,
  isUniqueViolation,
  outbox,
  type Tx,
} from "@clubadmin/db";
import { EmailSchema } from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { actorPersonId, parseInput } from "../../platform/domain/run.ts";
import type { ClubsService } from "../clubs/index.ts";
import type { MembershipsService } from "../memberships/index.ts";
import type { PeopleService } from "../people/index.ts";
import * as repo from "./accounts.repository.ts";

export type Account = repo.AccountRow;

export interface NewAccount {
  email: string;
  /** When the identity provider verified the address. */
  emailVerifiedAt: Date;
  idpSubject?: string | null;
  locale?: string | null;
}

export class AccountsService {
  private readonly db: Database;
  private readonly people: PeopleService;
  private readonly memberships: MembershipsService;
  private readonly clubs: ClubsService;
  private readonly defaultCountry: string;

  constructor(
    db: Database,
    deps: {
      people: PeopleService;
      memberships: MembershipsService;
      clubs: ClubsService;
      defaultCountry: string;
    },
  ) {
    this.db = db;
    this.people = deps.people;
    this.memberships = deps.memberships;
    this.clubs = deps.clubs;
    this.defaultCountry = deps.defaultCountry;
  }

  /** Creates the acting person's own account (sign-up; the IdP verified the email). */
  createAccount(context: ActorContext, input: NewAccount): Promise<Account> {
    return this.db.withActor(context, (tx) => this.createAccountInTx(tx, context, input));
  }

  async createAccountInTx(tx: Tx, context: ActorContext, input: NewAccount): Promise<Account> {
    const personId = actorPersonId(context);
    await this.people.getPersonInTx(tx, personId);
    if (await repo.findByPerson(tx, personId)) throw new DomainError("account_exists");
    const account = await this.insert(tx, personId, input);
    await audit.record(tx, {
      action: "account.created",
      resourceType: "account",
      resourceId: account.id,
    });
    return account;
  }

  getOwnAccount(context: ActorContext): Promise<Account | null> {
    return this.db.withActor(context, (tx) => repo.findByPerson(tx, actorPersonId(context)));
  }

  /** Changes the login email to a verified, unused address. The old address is notified (event). */
  changeEmail(context: ActorContext, newEmail: string, verifiedAt: Date): Promise<Account> {
    return this.db.withActor(context, async (tx) => {
      const personId = actorPersonId(context);
      const account = await repo.findByPerson(tx, personId);
      if (!account) throw new DomainError("not_found");
      const email = parseInput(EmailSchema, newEmail);
      if (email === account.email) return account;
      try {
        await repo.updateAccount(tx, account.id, { email, emailVerifiedAt: verifiedAt });
      } catch (error) {
        if (isUniqueViolation(error, "accounts_email_unique")) throw new DomainError("email_taken");
        throw error;
      }
      await audit.record(tx, {
        action: "account.email.changed",
        resourceType: "account",
        resourceId: account.id,
        changedFields: ["email"],
      });
      await outbox.publish(tx, "account.email.changed", { accountId: account.id, personId });
      return { ...account, email, emailVerifiedAt: verifiedAt };
    });
  }

  /**
   * "Give own login" (ADR 0020): links a new account to an existing person
   * without one, typically a child who received an invitation to their own
   * email. The acting person is that person (completing sign-up). Allowed
   * only from the country pack's own_account_min_age (the strictest pack of
   * the person's clubs, else the deployment's default country). All
   * memberships and history stay with the person.
   */
  linkAccount(context: ActorContext, input: NewAccount): Promise<Account> {
    return this.db.withActor(context, async (tx) => {
      const personId = actorPersonId(context);
      const person = await this.people.getPersonInTx(tx, personId);
      if (await repo.findByPerson(tx, personId)) throw new DomainError("account_exists");
      if (ageOn(person.birthDate) < (await this.ownAccountMinAge(tx, personId))) {
        throw new DomainError("too_young_for_account");
      }
      const account = await this.insert(tx, personId, input);
      await audit.record(tx, {
        action: "account.linked",
        resourceType: "account",
        resourceId: account.id,
      });
      return account;
    });
  }

  private async ownAccountMinAge(tx: Tx, personId: string): Promise<number> {
    const clubIds = await this.memberships.clubIdsOfPersonInTx(tx, personId);
    const countries = new Set((await this.clubs.findClubsInTx(tx, clubIds)).map((c) => c.country));
    if (countries.size === 0) countries.add(this.defaultCountry);
    return Math.max(
      ...[...countries]
        .filter(isSupportedCountry)
        .map((c) => getCountryPack(c).ageRules.ownAccountMinAge),
      getCountryPack(this.defaultCountry).ageRules.ownAccountMinAge,
    );
  }

  private async insert(tx: Tx, personId: string, input: NewAccount): Promise<Account> {
    const email = parseInput(EmailSchema, input.email);
    try {
      return await repo.insertAccount(tx, {
        personId,
        email,
        emailVerifiedAt: input.emailVerifiedAt,
        idpSubject: input.idpSubject ?? null,
        locale: input.locale ?? null,
      });
    } catch (error) {
      if (isUniqueViolation(error, "accounts_email_unique")) throw new DomainError("email_taken");
      if (isUniqueViolation(error, "accounts_person_unique"))
        throw new DomainError("account_exists");
      throw error;
    }
  }
}
