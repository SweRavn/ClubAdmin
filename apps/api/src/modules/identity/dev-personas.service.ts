// SPDX-License-Identifier: AGPL-3.0-only
// DEV_AUTH persona picker: everyone with a login, and the demo personas
// without one (children), with their clubs, roles and the description and
// tags from docs/demodata/personas.json. Only registered when DEV_AUTH is on
// (development); reads without an actor, club by club. Names go through the
// person presenter like everywhere else.

import type { PersonaList } from "@clubadmin/shared";

import { type DemoData, loadDemoData } from "../../seed/demodata.ts";
import type { AccountsService } from "../accounts/index.ts";
import type { PersonPresenter } from "../authorization/index.ts";
import type { ClubsService } from "../clubs/index.ts";
import type { MembershipsService } from "../memberships/index.ts";
import type { PeopleService } from "../people/index.ts";
import type { RolesService } from "../roles/index.ts";

const JOB = "dev:personas";

export class DevPersonasService {
  private readonly deps: {
    accounts: AccountsService;
    people: PeopleService;
    clubs: ClubsService;
    memberships: MembershipsService;
    roles: RolesService;
    presenter: PersonPresenter;
  };

  constructor(deps: DevPersonasService["deps"]) {
    this.deps = deps;
  }

  private demo: DemoData["personas"] | null | undefined;

  /** The demo personas, or none when docs/demodata is not available. */
  private demoPersonas(): DemoData["personas"] {
    if (this.demo === undefined) {
      try {
        this.demo = loadDemoData().personas;
      } catch {
        this.demo = null;
      }
    }
    return this.demo ?? [];
  }

  async list(): Promise<PersonaList> {
    const accounts = await this.deps.accounts.listAllForDevelopment();
    const withAccount = new Set(accounts.map((a) => a.personId));
    const demo = new Map(this.demoPersonas().map((p) => [p.id, p]));
    const people = await this.deps.people.listForDevelopment([
      ...withAccount,
      ...[...demo.keys()].filter((id) => !withAccount.has(id)),
    ]);
    const clubsOf = new Map<string, PersonaList["personas"][number]["clubs"]>();
    for (const club of await this.deps.clubs.listAllSystem(JOB)) {
      const roles = await this.deps.roles.activeAssignmentsSystem(JOB, club.id);
      const members = new Set(await this.deps.memberships.activeMembersSystem(JOB, club.id));
      for (const personId of new Set([...members, ...roles.map((r) => r.personId)])) {
        const entry = {
          clubId: club.id,
          clubName: club.name,
          roles: roles.filter((r) => r.personId === personId).map((r) => r.role),
        };
        clubsOf.set(personId, [...(clubsOf.get(personId) ?? []), entry]);
      }
    }
    return {
      personas: people
        .filter((p) => !p.mergedIntoPersonId && !p.anonymizedAt)
        .map((p) => ({
          // The picker is a development tool; it shows whom you log in as.
          person: this.deps.presenter.presentSelf(p),
          hasAccount: withAccount.has(p.id),
          description: demo.get(p.id)?.description ?? null,
          tags: demo.get(p.id)?.tags ?? [],
          clubs: clubsOf.get(p.id) ?? [],
        }))
        .sort((a, b) => a.person.displayName.localeCompare(b.person.displayName)),
    };
  }
}
