// SPDX-License-Identifier: AGPL-3.0-only
// The core step of the demo scenario (docs/seed-data.md): people, clubs,
// groups, relationships, waiting lists and the replayed history, written
// through the domain services with the persona as actor so that invariants,
// audit events and record history come out as in real use (ADR 0026).
//
// Past relationships are created with the transaction's seed time (history
// shows when they happened) and their validity is then backdated without a
// history row of its own (seed mode only). Tables whose flows arrive later
// (waiting lists, join requests, club invitations, consents, employments,
// support grants) have no service yet: their rows are inserted in a
// transaction of the acting persona, so history still records who did it.

import { randomBytes } from "node:crypto";

import { type ActorContext, sql, type TenantContext, type Tx } from "@clubadmin/db";
import { emailInvitationToken, hashInvitationSecret } from "@clubadmin/server-kit/invitations";
import {
  type DemoGroup,
  type DemoPersona,
  type GroupFunction,
  type RelativeTime,
  uuidv7,
} from "@clubadmin/shared";

import type { DemoData } from "../demodata.ts";
import type { DemoResult, SeedEnvironment } from "../environment.ts";
import type { GeneratedPerson } from "../generator.ts";

type Table =
  | "club_memberships"
  | "club_role_assignments"
  | "group_memberships"
  | "group_owners"
  | "guardianships";

const SEED_REQUEST = "seed:demo";

export async function seedCore(env: SeedEnvironment, data: DemoData): Promise<DemoResult> {
  const seeder = new CoreSeeder(env, data);
  await seeder.run();
  return { ids: seeder.ids, generated: seeder.generated };
}

class CoreSeeder {
  readonly ids = new Map<string, string>();
  readonly generated = new Map<string, string[]>();
  private readonly env: SeedEnvironment;
  private readonly data: DemoData;
  private readonly personas: Map<string, DemoPersona>;
  /** Group-membership row of (person key, group key), for moves. */
  private readonly groupRows = new Map<string, string>();

  constructor(env: SeedEnvironment, data: DemoData) {
    this.env = env;
    this.data = data;
    this.personas = new Map(data.personas.map((p) => [p.key, p]));
    for (const x of [...data.personas, ...data.clubs, ...data.groups]) this.ids.set(x.key, x.id);
  }

  private get s() {
    return this.env.services;
  }

  private id(key: string): string {
    const id = this.ids.get(key);
    if (!id) throw new Error(`no id for ${key}`);
    return id;
  }

  private club(key: string) {
    const club = this.data.clubs.find((c) => c.key === key);
    if (!club) throw new Error(`no club ${key}`);
    return club;
  }

  private group(key: string): DemoGroup {
    const group = this.data.groups.find((g) => g.key === key);
    if (!group) throw new Error(`no group ${key}`);
    return group;
  }

  /** The persona acting (optionally in a club, optionally at a past time). */
  private as(person: string, club?: null, at?: RelativeTime | Date | null): ActorContext;
  private as(person: string, club: string, at?: RelativeTime | Date | null): TenantContext;
  private as(
    person: string,
    club?: string | null,
    at?: RelativeTime | Date | null,
  ): ActorContext | TenantContext {
    const seedTime = at instanceof Date ? at : this.env.clock.past(at ?? null);
    const base: ActorContext = {
      actorKind: "person",
      personId: this.id(person),
      requestId: SEED_REQUEST,
      ...(seedTime ? { seedTime } : {}),
    };
    return club ? { ...base, clubId: this.id(club) } : base;
  }

  /** Sets the validity of a seeded row to its story (no history row of its own, seed mode). */
  private async backdate(
    table: Table,
    club: string | null,
    where: ReturnType<typeof sql>,
    period: { from?: Date | undefined; to?: Date | undefined },
  ): Promise<void> {
    if (!period.from && !period.to) return;
    const options = club ? { clubId: this.id(club) } : {};
    await this.env.db.withSystem("seed:backdate", options, async (tx) => {
      await tx.execute(sql`SELECT set_config('app.seed_skip_history', 'on', true)`);
      await tx.execute(sql`
        UPDATE ${sql.identifier(table)}
        SET valid_from = coalesce(${period.from ?? null}::timestamptz, valid_from),
            valid_to = coalesce(${period.to ?? null}::timestamptz, valid_to)
        WHERE ${where}`);
    });
  }

  async run(): Promise<void> {
    await this.people();
    await this.children();
    await this.clubs();
    await this.guardians();
    await this.memberships();
    await this.handovers();
    await this.roles();
    await this.groups();
    await this.groupMemberships();
    await this.clubGuardians();
    await this.ownLogins();
    await this.generatedMembers();
    await this.clubData();
    await this.waitlists();
    await this.laterHistory();
  }

  private birthDate(p: DemoPersona): string | null {
    return p.age === null ? null : this.env.clock.birthDate(p.age, p.birthday);
  }

  /** Adults with a login sign up themselves (person + account). */
  private async people(): Promise<void> {
    for (const p of this.data.personas) {
      if (p.login !== "account" || p.createdBy) continue;
      const self = this.as(p.key, null, p.createdAt);
      await this.s.people.createSelf(self, {
        givenName: p.givenName,
        familyName: p.familyName,
        birthDate: this.birthDate(p),
        gender: p.gender,
        phone: p.phone,
        address: p.address,
        protectedIdentity: p.protectedIdentity,
      });
      await this.s.accounts.createAccount(self, {
        email: p.email!,
        emailVerifiedAt: this.env.clock.past(p.createdAt) ?? this.env.clock.now,
        locale: p.locale,
      });
    }
  }

  /** Children are added by a guardian ("Add child"), without email. */
  private async children(): Promise<void> {
    for (const p of this.data.personas) {
      if (!p.createdBy) continue;
      const first = this.data.relationships.guardianships.find(
        (g) => g.ward === p.key && g.guardian === p.createdBy && g.via === "addChild",
      );
      await this.s.guardianships.addChild(
        this.as(p.createdBy, null, p.createdAt),
        {
          givenName: p.givenName,
          familyName: p.familyName,
          birthDate: this.birthDate(p)!,
          gender: p.gender,
          phone: p.phone,
          address: p.address,
        },
        first?.kind ?? "parent",
        { id: p.id },
      );
      if (p.protectedIdentity) {
        await this.s.people.setProtectedIdentity(this.as(p.createdBy), p.id, true);
      }
    }
  }

  /** The founder creates the club and becomes its first manager and member #1. */
  private async clubs(): Promise<void> {
    for (const c of this.data.clubs) {
      await this.s.onboarding.createClub(
        this.as(c.foundedBy, null, c.foundedAt),
        {
          name: c.name,
          shortName: c.shortName,
          slug: c.slug,
          country: c.country,
          joinPolicy: c.joinPolicy,
        },
        { id: c.id },
      );
      const from = this.env.clock.past(c.foundedAt);
      const where = sql`club_id = ${c.id} AND person_id = ${this.id(c.foundedBy)}`;
      await this.backdate("club_memberships", c.key, where, { from });
      await this.backdate("club_role_assignments", c.key, where, { from });
    }
  }

  /**
   * Co-guardians (invitation, accepted, pending or revoked), relatives added
   * by a full guardian, and people without login linked by a full guardian
   * or the adult ward (P1.3). Recorded by a club: clubGuardians().
   */
  private async guardians(): Promise<void> {
    for (const g of this.data.relationships.guardianships) {
      if (g.via === "addChild" || g.via === "club") continue;
      const by = g.by ?? this.personas.get(g.ward)?.createdBy;
      if (!by) throw new Error(`guardianship of ${g.ward}: who adds ${g.guardian}?`);
      if (g.via === "linked") {
        const p = this.personas.get(g.guardian)!;
        await this.s.guardianships.addLinkedPerson(
          this.as(by, null, p.createdAt),
          {
            wardPersonId: this.id(g.ward),
            person: { givenName: p.givenName, familyName: p.familyName, phone: p.phone },
            kind: g.kind,
            ...(g.rights ? { rights: g.rights } : {}),
          },
          { id: p.id },
        );
        continue;
      }
      if (g.via === "addGuardian") {
        await this.s.guardianships.addGuardian(this.as(by), {
          guardianPersonId: this.id(g.guardian),
          wardPersonId: this.id(g.ward),
          kind: g.kind,
          ...(g.rights ? { rights: g.rights } : {}),
        });
        continue;
      }
      const email = this.personas.get(g.guardian)?.email;
      if (!email) throw new Error(`invited guardian ${g.guardian} has no email`);
      const { token, invitationId } = await this.s.guardianships.inviteCoGuardian(this.as(by), {
        wardPersonId: this.id(g.ward),
        email,
        kind: g.kind,
        ...(g.rights ? { rights: g.rights } : {}),
      });
      if (g.status === "active") {
        await this.s.guardianships.acceptInvitation(this.as(g.guardian), token);
      } else if (g.status === "revoked") {
        await this.s.guardianships.revokeInvitation(this.as(by), invitationId);
      }
    }
  }

  private isGuardian(guardian: string, ward: string): boolean {
    return this.data.relationships.guardianships.some(
      (g) => g.guardian === guardian && g.ward === ward && g.status === "active",
    );
  }

  private async memberships(): Promise<void> {
    const r = this.data.relationships;
    const ordered = [...r.memberships].sort(
      (a, b) =>
        (this.env.clock.past(a.since)?.getTime() ?? Infinity) -
        (this.env.clock.past(b.since)?.getTime() ?? Infinity),
    );
    for (const m of ordered) {
      const club = this.club(m.club);
      const by = m.by ?? club.actor;
      const personId = this.id(m.person);
      const where = sql`club_id = ${club.id} AND person_id = ${personId}`;
      const ctx = this.as(by, m.club, m.since);
      const selfService = by === m.person || this.isGuardian(by, m.person);
      if (selfService && club.joinPolicy === "open") {
        await this.s.memberships.joinClub(ctx, personId, { membershipType: m.membershipType });
      } else {
        await this.s.memberships.addMember(ctx, personId, { membershipType: m.membershipType });
      }
      if (m.status === "left") {
        await this.s.memberships.leaveClub(this.as(m.person, m.club, m.until), personId);
      } else if (m.status === "paused") {
        await this.s.memberships.updateMembership(this.as(club.actor, m.club), personId, {
          status: "paused",
        });
      }
      await this.backdate("club_memberships", m.club, where, {
        from: this.env.clock.past(m.since),
        to: m.status === "left" ? this.env.clock.past(m.until) : undefined,
      });
    }
    // Applications approved in the past (history.json).
    for (const h of this.data.history) {
      if (h.action !== "membership.approve") continue;
      const [request] = await this.s.joinRequests.request(this.as(h.person, h.club, h.appliedAt), {
        personIds: [this.id(h.person)],
      });
      await this.s.joinRequests.decide(this.as(h.actor, h.club, h.at), request!.joinRequestId!, {
        decision: "approve",
      });
    }
  }

  /** Manager hand-overs: proposed a week before, accepted (or still open) at `at`. */
  private async handovers(): Promise<void> {
    for (const h of this.data.relationships.handovers) {
      const at = this.env.clock.at(h.at);
      const proposedAt = new Date(at.getTime() - (h.status === "accepted" ? 7 : 0) * 86_400_000);
      const handover = await this.s.roles.proposeHandover(
        this.as(h.from, h.club, proposedAt),
        this.id(h.to),
      );
      if (h.status !== "accepted") continue;
      await this.s.roles.acceptHandover(this.as(h.to, h.club, at), handover.id);
      const managerOf = (person: string) =>
        sql`club_id = ${this.id(h.club)} AND person_id = ${this.id(person)} AND role = 'club_manager'`;
      await this.backdate("club_role_assignments", h.club, managerOf(h.from), { to: at });
      await this.backdate(
        "club_role_assignments",
        h.club,
        sql`${managerOf(h.to)} AND valid_to IS NULL`,
        { from: at },
      );
    }
  }

  private async roles(): Promise<void> {
    for (const r of this.data.relationships.roles) {
      const club = this.club(r.club);
      const assignment = await this.s.roles.assignRole(
        this.as(r.by ?? club.actor, r.club, r.since),
        this.id(r.person),
        r.role,
      );
      if (r.until) {
        await this.s.roles.endRole(this.as(club.actor, r.club, r.until), this.id(r.person), r.role);
      }
      await this.backdate("club_role_assignments", r.club, sql`id = ${assignment.id}`, {
        from: this.env.clock.past(r.since),
        to: this.env.clock.past(r.until),
      });
    }
  }

  private groupName(g: DemoGroup): string {
    return g.birthYearAgo === null
      ? g.name
      : g.name.replace("{year}", String(this.env.clock.year(g.birthYearAgo)));
  }

  /** Groups (parents first) at the club's founding, then their owners. */
  private async groups(): Promise<void> {
    const pending = [...this.data.groups];
    const created = new Set<string>();
    while (pending.length > 0) {
      const index = pending.findIndex((g) => g.parent === null || created.has(g.parent));
      if (index < 0) throw new Error("group hierarchy has a cycle or an unknown parent");
      const [g] = pending.splice(index, 1) as [DemoGroup];
      const club = this.club(g.club);
      const year = g.birthYearAgo === null ? null : this.env.clock.year(g.birthYearAgo);
      await this.s.groups.createGroup(
        this.as(club.foundedBy, g.club, club.foundedAt),
        {
          name: this.groupName(g),
          kind: g.kind,
          parentGroupId: g.parent ? this.id(g.parent) : null,
          sport: g.sport,
          birthYearFrom: year,
          birthYearTo: year,
          genderCategory: g.genderCategory,
          capacity: g.capacity,
          admissionMode: g.admissionMode,
        },
        { id: g.id },
      );
      created.add(g.key);
    }
    for (const g of this.data.groups) {
      for (const owner of g.owners) {
        await this.s.groups.addOwner(
          this.as(this.club(g.club).actor, g.club),
          g.id,
          this.id(owner),
          "club_manager",
        );
      }
    }
  }

  private async addToGroup(
    person: string,
    personId: string,
    groupKey: string,
    fn: GroupFunction,
    by: string,
    at: RelativeTime | Date | null,
  ): Promise<void> {
    const g = this.group(groupKey);
    const row = await this.s.memberships.addToGroup(this.as(by, g.club, at), g.id, personId, fn);
    this.groupRows.set(`${person}/${groupKey}`, row.id);
    const from = at instanceof Date ? at : this.env.clock.past(at);
    await this.backdate("group_memberships", g.club, sql`id = ${row.id}`, { from });
  }

  private async groupMemberships(): Promise<void> {
    for (const m of this.data.relationships.groupMemberships) {
      const g = this.group(m.group);
      await this.addToGroup(
        m.person,
        this.id(m.person),
        m.group,
        m.function,
        m.by ?? this.club(g.club).actor,
        m.since,
      );
    }
    // Moves between groups (history.json).
    for (const h of this.data.history) {
      if (h.action !== "group.move") continue;
      const from = this.group(h.from);
      const rowId = this.groupRows.get(`${h.person}/${h.from}`);
      if (!rowId) throw new Error(`${h.person} is not in ${h.from}`);
      const at = this.env.clock.at(h.at);
      await this.s.memberships.endGroupMembership(this.as(h.actor, from.club, at), rowId);
      await this.backdate("group_memberships", from.club, sql`id = ${rowId}`, { to: at });
      await this.addToGroup(h.person, this.id(h.person), h.to, "member", h.actor, at);
    }
  }

  /** "Give own login": the guardian invites the child's address, the child signs up. */
  /**
   * Guardianships a club recorded from a paper form (P1.3), some later ended
   * by a club manager with a reason; then the worker's adult-age flags.
   */
  private async clubGuardians(): Promise<void> {
    const ended: { id: string; by: string; club: string; reason: string }[] = [];
    for (const g of this.data.relationships.guardianships) {
      if (g.via !== "club") continue;
      if (!g.club || !g.by) throw new Error(`club guardianship of ${g.ward}: club and by needed`);
      const p = this.personas.get(g.guardian)!;
      const { guardianship } = await this.s.guardianships.recordGuardian(
        this.as(g.by, g.club),
        {
          wardPersonId: this.id(g.ward),
          guardian: {
            person: { givenName: p.givenName, familyName: p.familyName, phone: p.phone },
          },
          kind: g.kind,
          ...(g.rights ? { rights: g.rights } : {}),
          ...(g.consentNote ? { consentNote: g.consentNote } : {}),
        },
        { id: p.id },
      );
      if (g.ended) ended.push({ id: guardianship.id, club: g.club, ...g.ended });
    }
    for (const e of ended) {
      await this.s.guardianships.endGuardianship(this.as(e.by, e.club), e.id, {
        allowedBy: "club_manager",
        reason: e.reason,
      });
    }
    // What guardianships:flag_adult_wards would have done on the birthday.
    for (const g of this.data.relationships.guardianships.filter((x) => x.adultFlagged)) {
      await this.env.db.withSystem("seed:adult-flag", {}, (tx) =>
        tx.execute(sql`
          UPDATE guardianships SET ward_adult_flagged_at = now()
          WHERE guardian_person_id = ${this.id(g.guardian)} AND ward_person_id = ${this.id(g.ward)}
            AND valid_to IS NULL`),
      );
    }
  }

  private async ownLogins(): Promise<void> {
    for (const o of this.data.relationships.ownLogins) {
      const p = this.personas.get(o.person)!;
      const at = this.env.clock.at(o.at);
      const { token } = await this.s.accounts.createOwnLoginInvitation(
        this.as(o.by, null, at),
        p.id,
        p.email!,
      );
      await this.s.accounts.acceptOwnLoginInvitation(
        { requestId: SEED_REQUEST, seedTime: at },
        token,
        { email: p.email!, emailVerifiedAt: at, locale: p.locale },
      );
    }
  }

  private generatedBirthDate(g: DemoGroup, age: number): string {
    const clock = this.env.clock;
    if (g.birthYearAgo === null) {
      const month = this.env.generator.int(1, 12);
      const day = this.env.generator.int(1, 28);
      return clock.birthDate(
        age,
        `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      );
    }
    // Born in the group's birth year, before today.
    const year = clock.year(g.birthYearAgo);
    const latest =
      year === clock.now.getUTCFullYear() ? clock.now : new Date(Date.UTC(year, 11, 31));
    const dayOfYear = this.env.generator.int(0, 364);
    const date = new Date(Math.min(Date.UTC(year, 0, 1 + dayOfYear), latest.getTime()));
    return date.toISOString().slice(0, 10);
  }

  /** Generated members fill the groups to their sizes (added by the club's actor). */
  private async generatedMembers(): Promise<void> {
    for (const g of this.data.groups) {
      if (!g.generated) continue;
      const club = this.club(g.club);
      const ctx = this.as(club.actor, g.club);
      const ids: string[] = [];
      for (let i = 0; i < g.generated.count; i++) {
        const person = this.env.generator.person(club.country, g.generated.gender);
        const age = this.env.generator.int(g.generated.ageFrom, g.generated.ageTo);
        await this.createGenerated(ctx, person, this.generatedBirthDate(g, age));
        await this.s.memberships.addMember(ctx, person.id);
        const row = await this.s.memberships.addToGroup(ctx, g.id, person.id);
        // In the group since last year, so past activities have them on the roster (P1.5).
        await this.backdate("group_memberships", g.club, sql`id = ${row.id}`, {
          from: this.env.clock.past("-1y"),
        });
        ids.push(person.id);
      }
      this.generated.set(g.key, ids);
      for (const personId of ids.slice(0, g.generated.clubProtected)) {
        await this.s.profiles.setClubProtection(
          this.as(g.generated.protectedBy ?? club.actor, g.club),
          personId,
          true,
        );
      }
    }
  }

  private async createGenerated(
    ctx: ActorContext,
    person: GeneratedPerson,
    birthDate: string,
  ): Promise<void> {
    await this.s.people.createPerson(
      ctx,
      {
        givenName: person.givenName,
        familyName: person.familyName,
        birthDate,
        gender: person.gender,
      },
      { id: person.id },
    );
  }

  /** Rows of modules whose flows come later, written as the acting persona. */
  private async clubData(): Promise<void> {
    const r = this.data.relationships;
    for (const s of r.sharedFields) {
      await this.s.profiles.updateProfile(this.as(s.person, s.club), this.id(s.person), {
        sharedFields: s.fields,
      });
    }
    for (const p of r.clubProtection) {
      await this.s.profiles.setClubProtection(this.as(p.by, p.club), this.id(p.person), true);
    }
    for (const e of r.employments) {
      await this.inClub(this.club(e.club).actor, e.club, (tx, clubId) =>
        tx.execute(sql`
          INSERT INTO employments (club_id, person_id, title, employment_type, starts_on, hours_per_week)
          VALUES (${clubId}, ${this.id(e.person)}, ${e.title}, ${e.employmentType},
                  ${this.env.clock.day(e.startsOn)}, ${e.hoursPerWeek})`),
      );
    }
    for (const c of r.consents) {
      await this.inClub(c.givenBy, c.club, (tx, clubId) =>
        tx.execute(sql`
          INSERT INTO consents (club_id, person_id, purpose, text_version, given_by_person_id)
          VALUES (${clubId}, ${this.id(c.person)}, ${c.purpose}, 'v1', ${this.id(c.givenBy)})`),
      );
    }
    for (const j of r.joinRequests) {
      const groups = j.preferredGroups.map((g) => this.id(g)).join(",");
      await this.inClub(j.requestedBy, j.club, (tx, clubId) =>
        tx.execute(sql`
          INSERT INTO join_requests (club_id, person_id, requested_by_person_id, preferred_group_ids, message)
          VALUES (${clubId}, ${this.id(j.person)}, ${this.id(j.requestedBy)},
                  ${`{${groups}}`}::uuid[], ${j.message})`),
      );
      if (j.status === "pending" || !j.decidedBy) continue;
      const by = j.decidedBy;
      await this.inClub(by, j.club, (tx, clubId) =>
        tx.execute(sql`
          UPDATE join_requests SET status = ${j.status}, decided_by_person_id = ${this.id(by)},
            decided_at = ${this.env.clock.at(j.decidedAt ?? "-1mo")}, decision_message = ${j.decisionMessage}
          WHERE club_id = ${clubId} AND person_id = ${this.id(j.person)} AND status = 'pending'`),
      );
    }
    for (const i of r.invitations) {
      // Demo secrets are fixed (development data); an email invitation's token
      // is derived from its ID when the key is set (ADR 0032).
      const id = uuidv7();
      const secret =
        i.kind === "link"
          ? i.token
          : i.kind === "code"
            ? i.code
            : this.env.invitationTokenKey
              ? emailInvitationToken(this.env.invitationTokenKey, id)
              : randomBytes(32).toString("base64url");
      const email = i.kind === "email" ? i.email : null;
      const maxUses = i.kind === "email" ? 1 : i.maxUses;
      await this.inClub(i.createdBy, i.club, (tx, clubId) =>
        tx.execute(sql`
          INSERT INTO invitations (id, club_id, kind, email, token_hash, group_id, expires_at, max_uses, created_by_person_id)
          VALUES (${id}, ${clubId}, ${i.kind}, ${email}, ${hashInvitationSecret(secret)},
                  ${i.group ? this.id(i.group) : null}, ${this.env.clock.at(i.expiresIn)}, ${maxUses},
                  ${this.id(i.createdBy)})`),
      );
    }
    // Records of past exports (the export expired; the file is gone).
    for (const x of r.memberExports) {
      const at = this.env.clock.past(x.at) ?? new Date();
      await this.inClub(x.requestedBy, x.club, (tx, clubId) =>
        tx.execute(sql`
          INSERT INTO member_exports (club_id, requested_by_person_id, status, columns, row_count,
            expires_at, created_at, updated_at)
          VALUES (${clubId}, ${this.id(x.requestedBy)}, 'expired',
            ${`{${x.columns.join(",")}}`}::text[], ${x.rowCount},
            ${new Date(at.getTime() + 86_400_000)}, ${at}, ${at})`),
      );
    }
    for (const operator of r.operators) await this.env.addPlatformOperator(this.id(operator));
    for (const g of r.supportGrants) {
      await this.inClub(g.grantedBy, g.club, (tx, clubId) =>
        tx.execute(sql`
          INSERT INTO support_access_grants (club_id, operator_person_id, granted_by_person_id, reason, expires_at)
          VALUES (${clubId}, ${this.id(g.operator)}, ${this.id(g.grantedBy)}, ${g.reason},
                  ${this.env.clock.at(g.expiresIn)})`),
      );
    }
  }

  private inClub(
    person: string,
    club: string,
    fn: (tx: Tx, clubId: string) => Promise<unknown>,
  ): Promise<unknown> {
    const ctx = this.as(person, club);
    return this.env.db.withTenant(ctx, (tx) => fn(tx, ctx.clubId));
  }

  /** Waiting lists (behaviour in P1.10): generated applicants come with a generated guardian. */
  private async waitlists(): Promise<void> {
    for (const w of this.data.waitlists) {
      const g = this.group(w.group);
      const club = this.club(g.club);
      const ctx = this.as(club.actor, g.club);
      let personId: string;
      let requestedBy: string;
      if (w.admittedMember !== null) {
        personId = this.generated.get(g.key)?.[w.admittedMember] ?? "";
        if (!personId) throw new Error(`no generated member ${w.admittedMember} in ${g.key}`);
        requestedBy = personId;
      } else if (w.person) {
        personId = this.id(w.person);
        requestedBy = this.id(w.requestedBy ?? w.person);
      } else {
        const guardian = this.env.generator.person(club.country);
        const child = {
          ...this.env.generator.person(club.country, g.generated?.gender ?? null),
          familyName: guardian.familyName,
        };
        await this.createGenerated(
          ctx,
          guardian,
          this.env.clock.birthDate(this.env.generator.int(32, 48), "03-01"),
        );
        await this.createGenerated(
          ctx,
          child,
          this.generatedBirthDate(g, g.generated?.ageFrom ?? 9),
        );
        personId = child.id;
        requestedBy = guardian.id;
      }
      const offerExpiresAt = w.offerExpiresIn ? this.env.clock.at(w.offerExpiresIn) : null;
      const decidedAt =
        w.status === "waiting"
          ? null
          : offerExpiresAt
            ? new Date(offerExpiresAt.getTime() - 7 * 86_400_000)
            : this.env.clock.at("-2mo");
      await this.env.db.withTenant(ctx, (tx) =>
        tx.execute(sql`
          INSERT INTO group_waitlist_entries (
            club_id, group_id, person_id, requested_by_person_id, status, queued_at, priority,
            offer_expires_at, out_of_order_reason, decided_by_person_id, decided_at
          ) VALUES (
            ${ctx.clubId}, ${g.id}, ${personId}, ${requestedBy}, ${w.status},
            ${this.env.clock.at(w.queuedAt)}, ${w.priority}, ${offerExpiresAt}, ${w.outOfOrderReason},
            ${w.decidedBy ? this.id(w.decidedBy) : null}, ${decidedAt}
          )`),
      );
    }
  }

  /** The remaining replayed changes (history.json). */
  private async laterHistory(): Promise<void> {
    for (const h of this.data.history) {
      if (h.action === "person.update") {
        await this.s.people.updateProfile(this.as(h.actor, null, h.at), this.id(h.person), {
          phone: h.phone,
        });
      } else if (h.action === "waitlist.offer.expire") {
        const g = this.group(h.group);
        await this.env.db.withSystem(
          h.job,
          { clubId: this.id(g.club), seedTime: this.env.clock.at(h.at) },
          (tx) =>
            tx.execute(sql`
              UPDATE group_waitlist_entries SET status = 'expired'
              WHERE group_id = ${g.id} AND status = 'offered' AND offer_expires_at < now()`),
        );
      }
    }
  }
}

export type { DemoResult };
