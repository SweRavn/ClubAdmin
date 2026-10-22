// SPDX-License-Identifier: AGPL-3.0-only
// Rows of the member register (P1.2) as the viewer may see them: `limited`
// (board roles) gets name, member number, membership type and groups; `full`
// (club managers, registrars) also birth date, membership, roles, the
// shareable fields the person shared with the club, guardians with their
// phone numbers and missing consents. Names only through the PersonPresenter
// (ADR 0022); people the viewer may not see are left out.

import {
  type ClubRole,
  CONSENT_PURPOSES,
  type ConsentPurpose,
  type Gender,
  GENDERS,
  type GroupFunction,
  type GuardianshipKind,
  type MembershipType,
  type RegisterAccess,
  type RegisterMember,
  type RegisterStatus,
} from "@clubadmin/shared";

import type { RequestAuthorization } from "../request-authorization.ts";
import type { PersonPresenter, PresentablePerson } from "./person.presenter.ts";

/** A register row (members repository), structurally. */
export interface PresentableRegisterRow {
  personId: string;
  status: RegisterStatus;
  membershipType: MembershipType;
  validFrom: string;
  validTo: string | null;
  memberNumber: number;
  birthDate: string | null;
  gender: string | null;
  sharedFields: string[];
  groups: { groupId: string; name: string; functions: GroupFunction[] }[];
  roles: ClubRole[];
  consents: ConsentPurpose[];
  guardians: { personId: string; kind: GuardianshipKind }[];
}

/** People of the page (members and their guardians); contact fields only for full access. */
export interface RegisterPerson extends PresentablePerson {
  phone?: string | null;
  address?: RegisterMember["address"];
}

const iso = (value: string) => new Date(value).toISOString();

export class RegisterPresenter {
  private readonly people: PersonPresenter;

  constructor(people: PersonPresenter) {
    this.people = people;
  }

  async present(
    authorization: RequestAuthorization,
    clubId: string,
    access: RegisterAccess,
    rows: readonly PresentableRegisterRow[],
    people: ReadonlyMap<string, RegisterPerson>,
  ): Promise<RegisterMember[]> {
    const wanted = new Set(rows.map((r) => r.personId));
    if (access === "full")
      for (const r of rows) for (const g of r.guardians) wanted.add(g.personId);
    const candidates = [...wanted].flatMap((id) => {
      const person = people.get(id);
      return person ? [person] : [];
    });
    const shown = new Map(
      (await this.people.present(authorization, clubId, candidates)).map((s) => [s.id, s]),
    );

    return rows.flatMap((row): RegisterMember[] => {
      const person = shown.get(row.personId);
      if (!person) return [];
      const member: RegisterMember = {
        person,
        memberNumber: row.memberNumber,
        membershipType: row.membershipType,
        groups: row.groups.map((g) => ({
          groupId: g.groupId,
          name: g.name,
          functions: g.functions,
        })),
      };
      if (access !== "full") return [member];

      const shared = new Set(row.sharedFields);
      const contact = people.get(row.personId);
      member.birthDate = row.birthDate;
      member.membership = {
        status: row.status,
        validFrom: iso(row.validFrom),
        validTo: row.validTo ? iso(row.validTo) : null,
      };
      member.roles = row.roles;
      member.phone = shared.has("phone") ? (contact?.phone ?? null) : null;
      member.address = shared.has("address") ? (contact?.address ?? null) : null;
      member.gender =
        shared.has("gender") && GENDERS.includes(row.gender as Gender)
          ? (row.gender as Gender)
          : null;
      member.guardians = row.guardians.flatMap((g) => {
        const guardian = shown.get(g.personId);
        return guardian
          ? [{ person: guardian, kind: g.kind, phone: people.get(g.personId)?.phone ?? null }]
          : [];
      });
      member.missingConsents = CONSENT_PURPOSES.filter((p) => !row.consents.includes(p));
      return [member];
    });
  }
}
