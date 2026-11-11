// SPDX-License-Identifier: AGPL-3.0-only
// Protected identity (P1.12, ADR 0022): turning the flags on and off with
// the removal rule and the step-ups, the protection state the profile shows
// to those who may change it, the person's access log across clubs and the
// club's profile view log for club managers, and the club's logging mode.

import { ageOn } from "@clubadmin/country-packs";
import { audit, type Database } from "@clubadmin/db";
import type {
  ClubProfileViews,
  ClubProfileViewsQuery,
  PersonSummary,
  ProfileViewEntry,
  ProfileViewer,
  ProfileViewLoggingMode,
  ProfileViewPage,
  ProtectionState,
} from "@clubadmin/shared";

import { ProblemError } from "../../platform/http/problem-error.ts";
import type { AccountsService } from "../accounts/index.ts";
import {
  type PersonPresenter,
  type PersonResource,
  type RequestAuthorization,
  tenantContext,
} from "../authorization/index.ts";
import type { ClubProfilesService } from "../club-profiles/index.ts";
import type { PeopleService, Person } from "../people/index.ts";
import * as repo from "./protection.repository.ts";

/** Turning protection off needs a login this recent (P1.12 decision 6). */
export const REMOVAL_RECENT_AUTH_MINUTES = 15;
const PAGE_SIZE = 50;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export class ProtectionService {
  private readonly db: Database;
  private readonly d: {
    people: PeopleService;
    profiles: ClubProfilesService;
    accounts: AccountsService;
    presenter: PersonPresenter;
  };

  constructor(
    db: Database,
    deps: {
      people: PeopleService;
      profiles: ClubProfilesService;
      accounts: AccountsService;
      presenter: PersonPresenter;
    },
  ) {
    this.db = db;
    this.d = deps;
  }

  /** The person may remove their own flag: from the strictest consent age of their clubs. */
  private async selfMayRemove(authz: RequestAuthorization, person: Person): Promise<boolean> {
    if (!person.birthDate) return true;
    const rules = await this.db.withActor(authz.context, (tx) =>
      this.d.accounts.ageRulesInTx(tx, person.id),
    );
    return ageOn(person.birthDate) >= rules.consentAge;
  }

  private requireRecentLogin(authz: RequestAuthorization): void {
    const at = authz.principal.authTime?.getTime() ?? 0;
    if (Date.now() - at > REMOVAL_RECENT_AUTH_MINUTES * 60_000) {
      throw new ProblemError("reauthentication-required", { detail: "recent_auth_required" });
    }
  }

  /** The global flag (the person or a full guardian); off needs a recent login. */
  async setGlobal(authz: RequestAuthorization, personId: string, enabled: boolean): Promise<void> {
    if (!enabled) this.requireRecentLogin(authz);
    const self = authz.actor.isSelf(personId);
    const person = self ? await this.d.people.getPerson(authz.context, personId) : null;
    await this.d.people.setProtectedIdentity(authz.context, personId, enabled, {
      selfMayRemove: person ? await this.selfMayRemove(authz, person) : true,
    });
  }

  /** The club flag (club managers with a second factor, checked by the policy). */
  async setClub(
    authz: RequestAuthorization,
    clubId: string,
    personId: string,
    enabled: boolean,
  ): Promise<void> {
    await this.d.profiles.setClubProtection(tenantContext(authz, clubId), personId, enabled);
  }

  /**
   * The protection state for the profile: for the person, full guardians and
   * (with a club) club managers; undefined for everyone else.
   */
  async state(
    authz: RequestAuthorization,
    resource: PersonResource,
    person: Person,
  ): Promise<ProtectionState | undefined> {
    const self = authz.actor.isSelf(resource.personId);
    const guardian = authz.actor.isGuardianOf(resource.personId, "act_on_behalf");
    const manager =
      resource.clubId !== null &&
      resource.inClub !== null &&
      authz.actor.onBehalfOf === null &&
      authz.actor.holds("person.protection.set", resource.clubId);
    if (!self && !guardian && !manager) return undefined;
    const clubId = manager ? resource.clubId : null;
    const details = clubId
      ? await this.db.withTenant(tenantContext(authz, clubId), (tx) =>
          repo.protectionDetails(tx, resource.personId, clubId),
        )
      : await this.db.withActor(authz.context, (tx) =>
          repo.protectionDetails(tx, resource.personId, null),
        );
    let canRemoveGlobal = false;
    if (person.protectedIdentity && (self || guardian)) {
      const me = authz.context.personId ?? null;
      canRemoveGlobal = self
        ? await this.selfMayRemove(authz, person)
        : details.globalSetBy === null ||
          details.globalSetBy === me ||
          !details.globalSetByIsFullGuardian;
    }
    let clubSetBy: PersonSummary | null = null;
    if (manager && clubId && details.clubSetBy) {
      const [setter] = await this.d.people.historyPeople([details.clubSetBy]);
      clubSetBy = setter ? await this.d.presenter.presentOne(authz, clubId, setter) : null;
    }
    return {
      global: person.protectedIdentity,
      globalSetAt: iso(person.protectedIdentitySetAt),
      club: manager ? (details.club ?? false) : null,
      clubSetAt: manager ? iso(details.clubSetAt) : null,
      clubSetBy,
      canChangeGlobal: self || guardian,
      canRemoveGlobal,
      canChangeClub: manager,
    };
  }

  /** The person's log across clubs (the person and full guardians; the function checks). */
  async accessLog(
    authz: RequestAuthorization,
    personId: string,
    cursor: string | null,
  ): Promise<ProfileViewPage> {
    const rows = await this.db.withActor(authz.context, (tx) =>
      repo.personLog(tx, personId, cursor, PAGE_SIZE + 1),
    );
    return this.page(authz, rows, false);
  }

  /** The club's log (club managers with a second factor). */
  async clubLog(
    authz: RequestAuthorization,
    clubId: string,
    query: ClubProfileViewsQuery,
  ): Promise<ClubProfileViews> {
    const { rows, mode } = await this.db.withTenant(tenantContext(authz, clubId), async (tx) => ({
      rows: await repo.clubLog(tx, clubId, query, PAGE_SIZE + 1),
      mode: await repo.loggingMode(tx, clubId),
    }));
    return { ...(await this.page(authz, rows, true)), mode };
  }

  /** The club's logging mode (club managers with a second factor); audited when it changes. */
  async setLoggingMode(
    authz: RequestAuthorization,
    clubId: string,
    mode: ProfileViewLoggingMode,
  ): Promise<void> {
    await this.db.withTenant(tenantContext(authz, clubId), async (tx) => {
      if (await repo.setLoggingMode(tx, clubId, mode)) {
        await audit.record(tx, {
          action: "club.settings.updated",
          resourceType: "club",
          resourceId: clubId,
          changedFields: ["profile_view_logging"],
        });
      }
    });
  }

  /** A page of log rows with names (in each row's club), roles and the next cursor. */
  private async page(
    authz: RequestAuthorization,
    all: readonly repo.ViewRow[],
    withPerson: boolean,
  ): Promise<ProfileViewPage> {
    const rows = all.slice(0, PAGE_SIZE);
    const ids = [
      ...new Set(
        rows.flatMap((r) => [
          ...(r.viewerPersonId ? [r.viewerPersonId] : []),
          ...(r.onBehalfOfPersonId ? [r.onBehalfOfPersonId] : []),
          ...(withPerson && r.viewedPersonId ? [r.viewedPersonId] : []),
        ]),
      ),
    ];
    const people = await this.d.people.historyPeople(ids);
    // Roles are club data: read club by club (rows without a club: guardians only).
    const context: repo.ViewContext = { clubNames: new Map(), roles: new Map() };
    for (const clubId of new Set(rows.map((r) => r.clubId))) {
      const part = await this.db.withSystem(
        "protection:access-log",
        clubId ? { clubId } : {},
        (tx) =>
          repo.viewContext(
            tx,
            rows.filter((r) => r.clubId === clubId),
          ),
      );
      for (const [k, v] of part.clubNames) context.clubNames.set(k, v);
      for (const [k, v] of part.roles) context.roles.set(k, v);
    }
    const byId = new Map(people.map((p) => [p.id, p]));
    // Names as the reader may see them in the club where the view happened.
    const shownByClub = new Map<string | null, Map<string, PersonSummary>>();
    for (const clubId of new Set(rows.map((r) => r.clubId))) {
      const inClub = rows
        .filter((r) => r.clubId === clubId)
        .flatMap((r) => [r.viewerPersonId, r.onBehalfOfPersonId, r.viewedPersonId])
        .flatMap((id) => {
          const p = id ? byId.get(id) : undefined;
          return p && !p.erased ? [p] : [];
        });
      const shown = await this.d.presenter.present(authz, clubId, [
        ...new Map(inClub.map((p) => [p.id, p])).values(),
      ]);
      shownByClub.set(clubId, new Map(shown.map((s) => [s.id, s])));
    }
    const who = (r: repo.ViewRow, id: string | null, operator: boolean): ProfileViewer => {
      if (operator) return { kind: "operator" };
      if (!id) return { kind: "former_member" };
      const person = shownByClub.get(r.clubId)?.get(id);
      if (person) return { kind: "person", person };
      return byId.get(id)?.erased ? { kind: "former_member" } : { kind: "protected" };
    };
    const items = rows.map((r): ProfileViewEntry => ({
      id: r.id,
      day: r.day,
      firstViewedAt: r.firstViewedAt.toISOString(),
      lastViewedAt: r.lastViewedAt.toISOString(),
      count: r.viewCount,
      surface: r.surface,
      protected: r.protected,
      club: r.clubId ? { id: r.clubId, name: context.clubNames.get(r.clubId) ?? "" } : null,
      viewer: who(r, r.viewerPersonId, r.viewerKind === "operator"),
      onBehalfOf: r.onBehalfOfPersonId
        ? (shownByClub.get(r.clubId)?.get(r.onBehalfOfPersonId) ?? null)
        : null,
      viewerRole:
        r.viewerPersonId && r.viewerKind !== "operator"
          ? (context.roles.get(repo.roleKey(r.clubId, r.viewerPersonId, r.viewedPersonId)) ?? null)
          : null,
      ...(withPerson ? { person: who(r, r.viewedPersonId, false) } : {}),
    }));
    return { items, nextCursor: all.length > PAGE_SIZE ? rows.at(-1)!.id : null };
  }
}
