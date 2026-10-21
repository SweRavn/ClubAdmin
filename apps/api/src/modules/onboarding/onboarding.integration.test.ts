// SPDX-License-Identifier: AGPL-3.0-only
import { expectTenantIsolation } from "@clubadmin/db/testing";
import { describe, expect, it } from "vitest";

import { isDomainError } from "../../platform/domain/domain-error.ts";
import { actor, buildClub, buildPerson } from "../../testing/builders.ts";
import { auditActionsOf, historyOf, useCoreDatabase } from "../../testing/core.ts";

const c = useCoreDatabase();

describe("creating a club", () => {
  it("makes the creator club manager and active member #1, with audit and history", async () => {
    const creator = await buildPerson(c.s);
    const club = await c.s.onboarding.createClub(actor(creator.id), {
      name: "Strandvikens Volleybollklubb",
      slug: "strandviken-vbk",
      country: "SE",
    });
    const ctx = actor(creator.id, club.id);

    expect(club).toMatchObject({
      country: "SE",
      defaultLocale: "sv-SE",
      timeZone: "Europe/Stockholm",
      currency: "SEK",
      joinPolicy: "approval",
      status: "active",
    });
    expect(await c.s.roles.activeManagers(ctx)).toEqual([creator.id]);
    const profile = await c.s.profiles.getProfile(ctx, creator.id);
    expect(profile.memberNumber).toBe(1);
    const mine = await c.s.memberships.myClubsAndGroups(actor(creator.id), creator.id);
    expect(mine.clubs).toEqual([
      expect.objectContaining({
        clubId: club.id,
        status: "active",
        name: "Strandvikens Volleybollklubb",
      }),
    ]);

    expect(await auditActionsOf(c.t, club.id)).toEqual(["club.created"]);
    const { rows: audits } = await c.t.query<{ action: string; actor_person_id: string }>(
      "admin",
      "SELECT action, actor_person_id FROM audit.events WHERE club_id = $1 ORDER BY id",
      [club.id],
    );
    expect(audits.map((a) => a.action)).toEqual([
      "club.created",
      "membership.created",
      "club.role.assigned",
    ]);
    expect(new Set(audits.map((a) => a.actor_person_id))).toEqual(new Set([creator.id]));

    const clubHistory = await historyOf(c.t, "public.clubs", club.id);
    expect(clubHistory).toEqual([
      expect.objectContaining({ operation: "INSERT", actor_person_id: creator.id }),
    ]);
    const { rows: tables } = await c.t.query<{ table_name: string }>(
      "admin",
      "SELECT DISTINCT table_name FROM history.record_changes WHERE club_id = $1 ORDER BY 1",
      [club.id],
    );
    expect(tables.map((r) => r.table_name)).toEqual([
      "public.club_memberships",
      "public.club_profiles",
      "public.club_role_assignments",
      "public.clubs",
    ]);
  });

  it("takes locale, time zone and currency from the country pack", async () => {
    const club = await buildClub(c.s, { country: "NO" });
    expect(club).toMatchObject({
      defaultLocale: "nb-NO",
      timeZone: "Europe/Oslo",
      currency: "NOK",
    });
  });

  it("rejects a taken slug and unsupported countries", async () => {
    const club = await buildClub(c.s);
    const other = await buildPerson(c.s);
    await expect(
      c.s.onboarding.createClub(actor(other.id), { name: "Copy", slug: club.slug, country: "SE" }),
    ).rejects.toSatisfy((e) => isDomainError(e, "club_slug_taken"));
    await expect(
      c.s.onboarding.createClub(actor(other.id), {
        name: "Danish",
        slug: "dk-club",
        country: "DK",
      }),
    ).rejects.toSatisfy((e) => isDomainError(e, "unsupported_country"));
  });

  it("updates settings with an audit event naming only changed fields", async () => {
    const club = await buildClub(c.s);
    const updated = await c.s.clubs.updateSettings(club.ctx, {
      joinPolicy: "open",
      ownersCanAppointCoOwners: true,
      name: club.name,
    });
    expect(updated).toMatchObject({ joinPolicy: "open", ownersCanAppointCoOwners: true });
    const { rows } = await c.t.query<{ changed_fields: string[] }>(
      "admin",
      "SELECT changed_fields FROM audit.events WHERE resource_id = $1 AND action = 'club.settings.updated'",
      [club.id],
    );
    expect(rows[0]?.changed_fields.sort()).toEqual(["joinPolicy", "ownersCanAppointCoOwners"]);
  });

  it("member numbers do not change club history", async () => {
    const club = await buildClub(c.s);
    const person = await buildPerson(c.s);
    await c.s.memberships.addMember(club.ctx, person.id);
    expect(await historyOf(c.t, "public.clubs", club.id)).toHaveLength(1);
    expect((await c.s.profiles.getProfile(club.ctx, person.id)).memberNumber).toBe(2);
  });

  it("is isolated from other clubs", async () => {
    const club = await buildClub(c.s);
    const other = await buildClub(c.s);
    await expectTenantIsolation(c.t.db, other.id, (tx) =>
      tx.execute(`SELECT id FROM public.clubs WHERE id = '${club.id}'`),
    );
    await expectTenantIsolation(c.t.db, other.id, (tx) =>
      tx.execute(`UPDATE public.clubs SET name = 'x' WHERE id = '${club.id}'`),
    );
  });
});
