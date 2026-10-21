// SPDX-License-Identifier: AGPL-3.0-only
// The only place a person's name becomes API output (CLAUDE.md rule 4,
// ADR 0022). Every response, export, notification and history view that
// mentions people maps the rows here, after PersonVisibility decided who the
// viewer may see. The lint rule clubadmin/person-names-in-presenters keeps
// name fields out of every other file.

import type { ActorReference, PersonSummary } from "@clubadmin/shared";

import { type PersonVisibility, type ResolveOptions } from "../person-visibility.service.ts";
import type { RequestAuthorization } from "../request-authorization.ts";

/** What the presenter needs of a person row (PeopleService summaries). */
export interface PresentablePerson {
  id: string;
  givenName: string;
  familyName: string;
  /** The global flag; the club flag comes from the club's protected set. */
  protectedIdentity: boolean;
}

function summary(person: PresentablePerson, isProtected: boolean): PersonSummary {
  return {
    id: person.id,
    displayName: `${person.givenName} ${person.familyName}`.trim(),
    givenName: person.givenName,
    familyName: person.familyName,
    protected: isProtected,
  };
}

export class PersonPresenter {
  private readonly visibility: PersonVisibility;

  constructor(visibility: PersonVisibility) {
    this.visibility = visibility;
  }

  /**
   * The people the viewer may see, in the given order; hidden people are left
   * out (callers report counts separately where needed).
   */
  async present(
    authorization: RequestAuthorization,
    clubId: string | null,
    people: readonly PresentablePerson[],
    options: Omit<ResolveOptions, "flags"> = {},
  ): Promise<PersonSummary[]> {
    const visible = await this.visibility.resolve(
      authorization,
      clubId,
      people.map((p) => p.id),
      { ...options, flags: new Map(people.map((p) => [p.id, p.protectedIdentity])) },
    );
    return people.flatMap((p) => {
      const v = visible.get(p.id);
      return v === "full" || v === "protected_visible"
        ? [summary(p, v === "protected_visible")]
        : [];
    });
  }

  /** One person, or null if the viewer may not see them. */
  async presentOne(
    authorization: RequestAuthorization,
    clubId: string | null,
    person: PresentablePerson,
  ): Promise<PersonSummary | null> {
    return (await this.present(authorization, clubId, [person]))[0] ?? null;
  }

  /** Who did something (history, audit): a hidden person becomes { kind: "protected" }. */
  async presentActors(
    authorization: RequestAuthorization,
    clubId: string,
    actors: readonly (PresentablePerson | null)[],
  ): Promise<ActorReference[]> {
    const people = actors.filter((a): a is PresentablePerson => a !== null);
    const shown = new Map(
      (await this.present(authorization, clubId, people)).map((s) => [s.id, s]),
    );
    return actors.map((a): ActorReference => {
      if (a === null) return { kind: "system" };
      const person = shown.get(a.id);
      return person ? { kind: "person", person } : { kind: "protected" };
    });
  }

  /** The viewer's own person (GET /me; the DEV_AUTH picker shows whom you log in as). */
  presentSelf(person: PresentablePerson): PersonSummary {
    return summary(person, person.protectedIdentity);
  }
}
