// SPDX-License-Identifier: AGPL-3.0-only
// Field-level filtering of a person's profile (docs/domain-model.md, "Field
// visibility"): which fields the viewer sees depends on their relationship
// (profileAccess). Shareable fields (phone, address, gender) reach a club only
// if the person shared them with it (club_profiles.shared_fields).

import {
  type Gender,
  GENDERS,
  type GroupFunction,
  type GuardianshipKind,
  type PersonProfile,
} from "@clubadmin/shared";

import type { ProfileAccess } from "../authorization.policy.ts";
import type { PersonResource } from "../policy.ts";
import type { RequestAuthorization } from "../request-authorization.ts";
import type { PersonPresenter, PresentablePerson } from "./person.presenter.ts";

export interface ProfilePerson extends PresentablePerson {
  birthDate: string | null;
  gender: string | null;
  phone: string | null;
  address: PersonProfile["address"];
}

export interface ProfileGuardian {
  kind: GuardianshipKind;
  person: PresentablePerson & { phone: string | null };
}

export class PersonProfilePresenter {
  private readonly people: PersonPresenter;

  constructor(people: PersonPresenter) {
    this.people = people;
  }

  /** The profile as the viewer may see it, or null if they may not see the person. */
  async present(
    authorization: RequestAuthorization,
    access: ProfileAccess,
    resource: PersonResource,
    person: ProfilePerson,
    guardians: readonly ProfileGuardian[],
  ): Promise<PersonProfile | null> {
    const summary = await this.people.presentOne(authorization, resource.clubId, person);
    if (!summary) return null;
    const profile: PersonProfile = { person: summary };
    if (access === "member") return profile;

    const shared = new Set(resource.inClub?.sharedFields ?? []);
    const sees = (field: "phone" | "address" | "gender") =>
      access === "self" || (shared.has(field) && (access === "admin" || field === "phone"));
    profile.birthDate = person.birthDate;
    if (sees("phone")) profile.phone = person.phone;
    if (sees("gender")) {
      profile.gender = GENDERS.includes(person.gender as Gender) ? (person.gender as Gender) : null;
    }
    if (sees("address")) profile.address = person.address;

    if (resource.clubId && resource.inClub) {
      const functions = new Map<string, GroupFunction[]>();
      for (const g of resource.groups) {
        functions.set(g.groupId, [...(functions.get(g.groupId) ?? []), g.function]);
      }
      profile.club = {
        clubId: resource.clubId,
        memberNumber: resource.inClub.memberNumber,
        groups: [...functions].map(([groupId, fns]) => ({ groupId, functions: fns.sort() })),
        ...(access === "leader" ? {} : { membership: resource.inClub.membership }),
      };
    }

    // Guardians (with their phone numbers) for whoever is responsible for the person.
    const shown = new Map(
      (
        await this.people.present(
          authorization,
          resource.clubId,
          guardians.map((g) => g.person),
        )
      ).map((s) => [s.id, s]),
    );
    profile.guardians = guardians.flatMap((g) => {
      const person = shown.get(g.person.id);
      return person ? [{ person, kind: g.kind, phone: g.person.phone }] : [];
    });
    return profile;
  }
}
