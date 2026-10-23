// SPDX-License-Identifier: AGPL-3.0-only
// Login accounts (ADR 0020): one per person, the only place an email lives,
// unique case-insensitively across the system. Rows are visible only to their
// own person, so duplicates are detected by the unique index, never by
// looking up other people's accounts.

import { createHash } from "node:crypto";

import { ageOn, type AgeRules, getCountryPack, isSupportedCountry } from "@clubadmin/country-packs";
import {
  type ActorContext,
  audit,
  type Database,
  isUniqueViolation,
  outbox,
  type Tx,
} from "@clubadmin/db";
import { accountInvitationToken } from "@clubadmin/server-kit/invitations";
import {
  EmailSchema,
  type Preferences,
  type SignUpPersonInput,
  THEMES,
  UI_LOCALES,
  type UpdatePreferencesInput,
  UpdatePreferencesSchema,
  uuidv7,
} from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import {
  actorPersonId,
  type Context,
  hasClub,
  parseInput,
  runAs,
} from "../../platform/domain/run.ts";
import type { ClubsService } from "../clubs/index.ts";
import type { MembershipsService } from "../memberships/index.ts";
import type { PeopleService } from "../people/index.ts";
import * as repo from "./accounts.repository.ts";

export type Account = repo.AccountRow;

function preferencesOf(account: Account | null): Preferences {
  // Stored values outside today's lists (older data) read as "not set".
  const pick = <T extends string>(value: string | null | undefined, allowed: readonly T[]) =>
    allowed.includes(value as T) ? (value as T) : null;
  return {
    locale: pick(account?.locale, UI_LOCALES),
    timeZone: account?.timeZone ?? null,
    theme: pick(account?.theme, THEMES),
  };
}

export const ACCOUNT_INVITATION_VALID_DAYS = 14;
const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest("base64url");

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
  private readonly tokenKey: string | undefined;

  constructor(
    db: Database,
    deps: {
      people: PeopleService;
      memberships: MembershipsService;
      clubs: ClubsService;
      defaultCountry: string;
      /** INVITATION_TOKEN_KEY: own-login invitations are emailed with a derived link (P1.3). */
      invitationTokenKey?: string | undefined;
    },
  ) {
    this.db = db;
    this.people = deps.people;
    this.memberships = deps.memberships;
    this.clubs = deps.clubs;
    this.defaultCountry = deps.defaultCountry;
    this.tokenKey = deps.invitationTokenKey;
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

  /** The acting person's account in any transaction (own_account policy). */
  ownAccountInTx(tx: Tx, personId: string): Promise<Account | null> {
    return repo.findByPerson(tx, personId);
  }

  /**
   * What a signed-up person needs before any club action (ADR 0018): a
   * verified login email and a completed profile (birth date, for age rules).
   */
  async requireReadyForClubsInTx(tx: Tx, personId: string): Promise<void> {
    const account = await repo.findByPerson(tx, personId);
    if (!account?.emailVerifiedAt) throw new DomainError("email_not_verified");
    const person = await this.people.getPersonInTx(tx, personId);
    if (!person.birthDate) throw new DomainError("profile_incomplete");
  }

  /** The account's preferences (all null for a person without an account). */
  getPreferences(context: ActorContext): Promise<Preferences> {
    return this.db.withActor(context, async (tx) =>
      preferencesOf(await repo.findByPersonId(tx, actorPersonId(context))),
    );
  }

  /** Changes language, time zone or theme; null clears a preference. */
  updatePreferences(context: ActorContext, input: UpdatePreferencesInput): Promise<Preferences> {
    return this.db.withActor(context, async (tx) => {
      const data = parseInput(UpdatePreferencesSchema, input);
      const account = await repo.findByPerson(tx, actorPersonId(context));
      if (!account) throw new DomainError("not_found");
      const current = preferencesOf(account);
      const changed = (Object.keys(data) as (keyof Preferences)[]).filter(
        (key) => data[key] !== undefined && data[key] !== current[key],
      );
      if (changed.length === 0) return current;
      const next = { ...current, ...Object.fromEntries(changed.map((k) => [k, data[k]])) };
      await repo.updateAccount(tx, account.id, next);
      await audit.record(tx, {
        action: "account.preferences.updated",
        resourceType: "account",
        resourceId: account.id,
        changedFields: changed,
      });
      return next;
    });
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
      // Unknown age counts as too young.
      if (
        !person.birthDate ||
        ageOn(person.birthDate) < (await this.ownAccountMinAge(tx, personId))
      ) {
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

  /**
   * Sign-up: a new person and their account in one transaction. The person
   * acts as themselves (`personId` is generated here). Used when someone logs
   * in for the first time (identity module).
   */
  signUp(
    context: { requestId?: string | null; ipHash?: string | null },
    person: SignUpPersonInput,
    account: NewAccount,
  ): Promise<Account> {
    const self: ActorContext = { actorKind: "person", personId: uuidv7(), ...context };
    return this.db.withActor(self, async (tx) => {
      await this.people.createSelfInTx(tx, self, person);
      return this.createAccountInTx(tx, self, account);
    });
  }

  /** Account by identity-provider subject, without an actor (resolving who is logging in). */
  findBySubject(idpSubject: string): Promise<Account | null> {
    return this.db.withSystem("auth:resolve", {}, (tx) => repo.findBySubject(tx, idpSubject));
  }

  /** Account of a person, without an actor (DEV_AUTH logins). */
  findByPerson(personId: string): Promise<Account | null> {
    return this.db.withSystem("auth:resolve", {}, (tx) => repo.findByPersonId(tx, personId));
  }

  /** People with a login (DEV_AUTH persona picker). */
  listAllForDevelopment(): Promise<{ personId: string; email: string }[]> {
    return this.db.withSystem("dev:personas", {}, (tx) => repo.listAll(tx));
  }

  /**
   * The identity provider reports a different verified email: take it over
   * (changed in Zitadel). Fails with email_taken if another account has it.
   */
  syncEmail(context: ActorContext, email: string, verifiedAt: Date): Promise<Account> {
    return this.db.withActor(context, async (tx) => {
      const account = await repo.findByPerson(tx, actorPersonId(context));
      if (!account) throw new DomainError("not_found");
      const normalized = parseInput(EmailSchema, email);
      if (normalized === account.email) return account;
      try {
        await repo.updateAccount(tx, account.id, {
          email: normalized,
          emailVerifiedAt: verifiedAt,
        });
      } catch (error) {
        if (isUniqueViolation(error, "accounts_email_unique")) throw new DomainError("email_taken");
        throw error;
      }
      await audit.record(tx, {
        action: "account.email.synced",
        resourceType: "account",
        resourceId: account.id,
        changedFields: ["email"],
      });
      await outbox.publish(tx, "account.email.changed", {
        accountId: account.id,
        personId: account.personId,
      });
      return { ...account, email: normalized, emailVerifiedAt: verifiedAt };
    });
  }

  /**
   * "Give own login" (ADR 0020): a full guardian (or a club manager or
   * registrar of a club the person belongs to) invites the person's own
   * email. The link's token is derived from the invitation's ID with
   * INVITATION_TOKEN_KEY (the worker emails it); only its hash is stored.
   */
  createOwnLoginInvitation(
    context: Context,
    personId: string,
    email: string,
  ): Promise<{ invitationId: string; token: string; expiresAt: Date }> {
    const key = this.tokenKey;
    if (!key) throw new DomainError("invitation_email_unavailable");
    return runAs(this.db, context, (tx) =>
      this.createOwnLoginInvitationInTx(tx, context, personId, email),
    );
  }

  /** createOwnLoginInvitation in the caller's transaction (adding and importing members, P1.3b). */
  async createOwnLoginInvitationInTx(
    tx: Tx,
    context: Context,
    personId: string,
    email: string,
  ): Promise<{ invitationId: string; token: string; expiresAt: Date }> {
    const key = this.tokenKey;
    if (!key) throw new DomainError("invitation_email_unavailable");
    const actor = actorPersonId(context);
    const allowed =
      (await repo.actorIsFullGuardianOf(tx, personId)) ||
      (hasClub(context) &&
        (await repo.actorHasClubRole(tx, ["club_manager", "registrar"])) &&
        (await this.memberships.isMemberInTx(tx, context.clubId, personId)));
    if (!allowed) throw new DomainError("not_allowed");
    const person = await this.people.getPersonInTx(tx, personId);
    // Accounts are visible only to their own person: ask the database.
    if ((await repo.peopleWithAccount(tx, [personId])).has(personId))
      throw new DomainError("account_exists");
    if (
      !person.birthDate ||
      ageOn(person.birthDate) < (await this.ownAccountMinAge(tx, personId))
    ) {
      throw new DomainError("too_young_for_account");
    }
    const id = uuidv7();
    const token = accountInvitationToken(key, id);
    const expiresAt = new Date(Date.now() + ACCOUNT_INVITATION_VALID_DAYS * 86_400_000);
    const invitation = await repo.insertInvitation(tx, {
      id,
      personId,
      email: parseInput(EmailSchema, email),
      tokenHash: hashToken(token),
      createdByPersonId: actor,
      expiresAt,
    });
    await audit.record(tx, {
      action: "account.invitation.created",
      resourceType: "account_invitation",
      resourceId: invitation.id,
    });
    await outbox.publish(tx, "account.invited", { invitationId: invitation.id, personId });
    return { invitationId: invitation.id, token, expiresAt };
  }

  /**
   * Completes sign-up from an own-login invitation: the new login is linked to
   * the invited person (memberships and history stay). The verified email
   * must be the address the invitation was sent to.
   */
  async acceptOwnLoginInvitation(
    context: Pick<ActorContext, "requestId" | "ipHash" | "seedTime">,
    token: string,
    account: NewAccount,
  ): Promise<Account> {
    const invitation = await this.db.withSystem("auth:invitation", {}, (tx) =>
      repo.findInvitation(tx, hashToken(token)),
    );
    if (!invitation) throw new DomainError("invitation_invalid");
    if (parseInput(EmailSchema, account.email) !== invitation.email)
      throw new DomainError("invitation_invalid");
    const self: ActorContext = { actorKind: "person", personId: invitation.personId, ...context };
    const linked = await this.linkAccount(self, account);
    await this.db.withActor(self, (tx) => repo.markInvitationAccepted(tx, invitation.invitationId));
    return linked;
  }

  private async ownAccountMinAge(tx: Tx, personId: string): Promise<number> {
    return (await this.ageRulesInTx(tx, personId)).ownAccountMinAge;
  }

  /**
   * The age rules for a person: the strictest (highest) of the country packs
   * of their clubs, the deployment's default country without clubs (P1.3).
   * Only the clubs visible to the transaction count (the person, their
   * guardians, a club they belong to).
   */
  async ageRulesInTx(tx: Tx, personId: string): Promise<AgeRules> {
    const clubIds = await this.memberships.clubIdsOfPersonInTx(tx, personId);
    const countries = (await this.clubs.findClubsInTx(tx, clubIds)).map((c) => c.country);
    return this.ageRulesFor(countries);
  }

  /** The strictest age rules of these countries (the default country if none is supported). */
  ageRulesFor(countries: readonly string[]): AgeRules {
    const packs = [...new Set(countries)]
      .filter(isSupportedCountry)
      .map((c) => getCountryPack(c).ageRules);
    if (packs.length === 0) packs.push(getCountryPack(this.defaultCountry).ageRules);
    return {
      consentAge: Math.max(...packs.map((p) => p.consentAge)),
      ownAccountMinAge: Math.max(...packs.map((p) => p.ownAccountMinAge)),
      adultAge: Math.max(...packs.map((p) => p.adultAge)),
    };
  }

  /** Which of these (reachable) people have a login (accounts are otherwise private). */
  peopleWithAccount(context: ActorContext, personIds: readonly string[]): Promise<Set<string>> {
    if (personIds.length === 0) return Promise.resolve(new Set());
    return this.db.withActor(context, (tx) => repo.peopleWithAccount(tx, personIds));
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
