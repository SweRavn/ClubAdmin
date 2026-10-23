// SPDX-License-Identifier: AGPL-3.0-only
// Adding a member to a club by hand or from an import row (P1.3b), in the
// caller's transaction, through the services that own the data: the person
// (people), the profile and membership with its start and member number
// (memberships), groups, guardians (any number: existing members, new people
// without login, or email invitations from the club) and the adult's own
// login invitation. Each service records its own audit events.

import { ageOn, getCountryPack } from "@clubadmin/country-packs";
import { type Database, savepoint, type TenantContext, type Tx } from "@clubadmin/db";
import {
  type AddMemberInput,
  AddMemberSchema,
  type Gender,
  type GuardianshipKind,
  type GuardianshipRight,
  type MembershipType,
  nameParts,
  newLinkedPerson,
  type ShareablePersonField,
} from "@clubadmin/shared";

import { DomainError, isDomainError } from "../../platform/domain/domain-error.ts";
import { actorPersonId, parseInput } from "../../platform/domain/run.ts";
import type { AccountsService } from "../accounts/index.ts";
import type { ClubsService } from "../clubs/index.ts";
import type { GroupsService } from "../groups/index.ts";
import type { GuardianshipsService } from "../guardianships/index.ts";
import type { MembershipsService } from "../memberships/index.ts";
import type { PeopleService } from "../people/index.ts";
import * as repo from "./members.repository.ts";

export interface IntakeGuardian {
  kind: GuardianshipKind;
  rights?: readonly GuardianshipRight[] | undefined;
  consentNote?: string | null | undefined;
  target:
    | { personId: string; createdByClub?: boolean }
    | { person: { given: string; family: string; phone: string | null }; id?: string }
    | { email: string };
}

/** A member to add, with names as plain parts (ADR 0022: no name fields outside presenters). */
export interface IntakeMember {
  names: { given: string; family: string };
  birthDate: string;
  personalIdentityNumber: { country: string; value: string } | null;
  gender: Gender | null;
  phone: string | null;
  address: { street: string; postalCode: string; city: string; country: string } | null;
  /** Club-level protected identity: no address is stored. */
  protected: boolean;
  membershipType: MembershipType;
  /** A calendar date in the club's time zone (not in the future); null: now. */
  startDate: string | null;
  /** A kept member number; null: the running number. */
  memberNumber: number | null;
  groupIds: readonly string[];
  guardians: readonly IntakeGuardian[];
  /** An adult's own email: an own-login invitation. */
  invitationEmail: string | null;
  /** A fixed ID for the new person (the demo seed). */
  id?: string;
}

export interface IntakeResult {
  personId: string;
  /** Per guardian in order: the person linked, or null for an email invitation. */
  guardianPersonIds: (string | null)[];
  invitations: number;
}

export class MemberIntakeService {
  private readonly db: Database;
  private readonly people: PeopleService;
  private readonly memberships: MembershipsService;
  private readonly groups: GroupsService;
  private readonly guardianships: GuardianshipsService;
  private readonly accounts: AccountsService;
  private readonly clubs: ClubsService;

  constructor(
    db: Database,
    deps: {
      people: PeopleService;
      memberships: MembershipsService;
      groups: GroupsService;
      guardianships: GuardianshipsService;
      accounts: AccountsService;
      clubs: ClubsService;
    },
  ) {
    this.db = db;
    this.people = deps.people;
    this.memberships = deps.memberships;
    this.groups = deps.groups;
    this.guardianships = deps.guardianships;
    this.accounts = deps.accounts;
    this.clubs = deps.clubs;
  }

  /**
   * "Add member" (club.members.add): one transaction; a failure leaves
   * nothing behind. Returns the new person's ID and the invitations sent.
   */
  addMember(context: TenantContext, input: AddMemberInput): Promise<IntakeResult> {
    return this.db.withTenant(context, async (tx) => {
      const data = parseInput(AddMemberSchema, input);
      if (!(await repo.actorHasClubRole(tx, ["club_manager", "registrar"])))
        throw new DomainError("not_allowed");
      const club = await this.clubs.getClubInTx(tx, context.clubId);
      let birthDate = data.birthDate ?? null;
      if (data.personalIdentityNumber) {
        const parsed = this.people.parsePersonalIdentityNumber(
          data.personalIdentityNumber.country,
          data.personalIdentityNumber.value,
        );
        if (!parsed) throw new DomainError("invalid_personal_identity_number");
        if (birthDate && birthDate !== parsed.birthDate)
          throw new DomainError("personal_identity_number_mismatch");
        birthDate = parsed.birthDate;
      }
      if (!birthDate) throw new DomainError("invalid_input");
      if (data.invitationEmail) {
        const adultAge = getCountryPack(club.country).ageRules.adultAge;
        if (ageOn(birthDate) < adultAge) throw new DomainError("minor_email_not_allowed");
      }
      if (data.protectedIdentity && data.address) throw new DomainError("protected_address");
      return this.addInTx(tx, context, {
        names: nameParts(data),
        birthDate,
        personalIdentityNumber: data.personalIdentityNumber ?? null,
        gender: data.gender ?? null,
        phone: data.phone ?? null,
        address: data.address ?? null,
        protected: data.protectedIdentity,
        membershipType: data.membershipType,
        startDate: data.startDate ?? null,
        memberNumber: null,
        groupIds: data.groupIds,
        guardians: data.guardians.map((g): IntakeGuardian => ({
          kind: g.kind,
          rights: g.rights,
          consentNote: g.consentNote ?? null,
          target:
            "personId" in g.guardian
              ? { personId: g.guardian.personId }
              : "email" in g.guardian
                ? { email: g.guardian.email }
                : {
                    person: {
                      ...nameParts(g.guardian.person),
                      phone: g.guardian.person.phone ?? null,
                    },
                  },
        })),
        invitationEmail: data.invitationEmail ?? null,
      });
    });
  }

  /**
   * Adds the member in the caller's transaction (the caller checked the
   * actor's club role). Groups the person is already in are kept.
   */
  async addInTx(
    tx: Tx,
    context: TenantContext,
    member: IntakeMember,
    options: {
      existingPersonId?: string | null;
      /** The groups are the club's active ones (an import resolved them by name). */
      groupsChecked?: boolean;
    } = {},
  ): Promise<IntakeResult> {
    actorPersonId(context);
    if (member.birthDate > todayIso()) throw new DomainError("birth_date_in_future");
    let personId: string;
    if (options.existingPersonId) {
      // "Same person" in an import: the club's existing member.
      personId = options.existingPersonId;
      if (!(await this.memberships.hasOpenMembershipInTx(tx, context.clubId, personId))) {
        await this.addMembershipInTx(tx, context, personId, member);
      }
    } else {
      const person = await this.people.createFromIntakeInTx(
        tx,
        context,
        {
          birthDate: member.birthDate,
          gender: member.gender,
          personalIdentityNumber: member.personalIdentityNumber,
          phone: member.phone,
          address: member.protected ? null : member.address,
          protectedIdentity: false,
        },
        member.names,
        member.id,
      );
      personId = person.id;
      await this.addMembershipInTx(tx, context, personId, member, { newPerson: true });
    }
    for (const groupId of new Set(member.groupIds)) {
      if (!options.existingPersonId) {
        // A new person is in no group yet.
        await this.memberships.addToGroupInTx(tx, context, groupId, personId, "member", {
          checked: options.groupsChecked === true,
        });
        continue;
      }
      try {
        await savepoint(tx, () => this.memberships.addToGroupInTx(tx, context, groupId, personId));
      } catch (error) {
        if (!isDomainError(error, "already_in_group")) throw error;
      }
    }
    const guardianPersonIds: (string | null)[] = [];
    let invitations = 0;
    for (const guardian of member.guardians) {
      const base = {
        wardPersonId: personId,
        kind: guardian.kind,
        rights: guardian.rights,
        consentNote: guardian.consentNote,
      };
      if ("email" in guardian.target) {
        await this.guardianships.inviteGuardianForClubInTx(
          tx,
          context,
          { ...base, email: guardian.target.email },
          { actorChecked: true, wardChecked: true },
        );
        invitations++;
        guardianPersonIds.push(null);
        continue;
      }
      const target = guardian.target;
      const record = () =>
        this.guardianships.recordGuardianInTx(
          tx,
          context,
          {
            ...base,
            guardian:
              "personId" in target
                ? { personId: target.personId }
                : {
                    person: newLinkedPerson(
                      target.person.given,
                      target.person.family,
                      target.person.phone,
                    ),
                  },
          },
          {
            actorChecked: true,
            wardChecked: true,
            createdByClub: "personId" in target && target.createdByClub === true,
            ...("person" in target && target.id ? { id: target.id } : {}),
          },
        );
      // "Same person" in an import: a guardian they already have is kept.
      if (options.existingPersonId && "personId" in target) {
        try {
          guardianPersonIds.push((await savepoint(tx, record)).personId);
        } catch (error) {
          if (!isDomainError(error, "guardianship_exists")) throw error;
          guardianPersonIds.push(target.personId);
        }
        continue;
      }
      const result = await record();
      guardianPersonIds.push(result.personId);
    }
    if (member.invitationEmail) {
      await this.accounts.createOwnLoginInvitationInTx(
        tx,
        context,
        personId,
        member.invitationEmail,
      );
      invitations++;
    }
    return { personId, guardianPersonIds, invitations };
  }

  /** Start of a day in the club's time zone, remembered (an import has few distinct dates). */
  private readonly days = new Map<string, Date | null>();
  private async startOfDay(tx: Tx, clubId: string, date: string): Promise<Date | null> {
    // Per day: a date in the future becomes valid later.
    const key = `${todayIso()}:${clubId}:${date}`;
    if (!this.days.has(key)) {
      if (this.days.size > 10_000) this.days.clear();
      this.days.set(key, await this.memberships.startOfDayInTx(tx, clubId, date));
    }
    return this.days.get(key)!;
  }

  private async addMembershipInTx(
    tx: Tx,
    context: TenantContext,
    personId: string,
    member: IntakeMember,
    options: { newPerson?: boolean } = {},
  ): Promise<void> {
    let validFrom: Date | undefined;
    if (member.startDate) {
      const at = await this.startOfDay(tx, context.clubId, member.startDate);
      if (!at) throw new DomainError("start_date_invalid");
      validFrom = at;
    }
    const shared: ShareablePersonField[] = [];
    if (member.phone) shared.push("phone");
    if (member.address && !member.protected) shared.push("address");
    if (member.gender) shared.push("gender");
    if (member.personalIdentityNumber) shared.push("personal_identity_number");
    await this.memberships.addMemberInTx(tx, context, personId, member.membershipType, {
      ...(validFrom ? { validFrom } : {}),
      newPerson: options.newPerson === true,
      profile: {
        sharedFields: shared,
        ...(member.memberNumber ? { memberNumber: member.memberNumber } : {}),
        ...(member.protected ? { protectedIdentityClub: true } : {}),
      },
    });
  }
}

const todayIso = () => new Date().toISOString().slice(0, 10);
