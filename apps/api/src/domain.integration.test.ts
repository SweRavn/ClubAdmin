// SPDX-License-Identifier: AGPL-3.0-only
// Tenant isolation for every club-owned table (club_id NOT NULL; a nullable
// club_id is a reference from a global table): a person of club B cannot read,
// change or create club A's rows. The table list comes from the database, so
// a new club-owned table without a fixture row here fails the test.
import { sql } from "@clubadmin/db";
import { expectTenantIsolation } from "@clubadmin/db/testing";
import { describe, expect, it } from "vitest";

import { actor, buildClub, buildFamily, buildPerson } from "./testing/builders.ts";
import { useCoreDatabase } from "./testing/core.ts";

const c = useCoreDatabase();

describe("tenant isolation of club-owned tables", () => {
  it("covers every table with club_id, plus clubs", async () => {
    const a = await buildClub(c.s);
    const b = await buildClub(c.s);
    const member = await buildPerson(c.s);
    await c.s.memberships.addMember(a.ctx, member.id);
    const group = await c.s.groups.createGroup(a.ctx, {
      name: "F2017",
      kind: "team",
      admissionMode: "waitlist",
    });
    await c.s.memberships.addToGroup(a.ctx, group.id, member.id);
    await c.s.groups.addOwner(a.ctx, group.id, member.id, "club_manager");
    await c.s.roles.proposeHandover(a.ctx, member.id);
    const season = await c.s.groups.createSeason(a.ctx, {
      name: "2026",
      startsOn: "2026-01-01",
      endsOn: "2026-12-31",
    });
    await c.s.groups.setGroupSeason(a.ctx, group.id, season.id, { capacity: 10 });
    const family = await buildFamily(c.s);
    // Activities (P1.4): a location, a match there, and a series (sessions, groups, calendar entries).
    const hall = await c.s.activities.createLocation(a.ctx, { name: "Sporthallen" });
    await c.s.activities.createActivity(a.ctx, group.id, {
      kind: "match",
      title: "Match",
      startsAt: "2026-11-07T10:00:00Z",
      endsAt: "2026-11-07T11:30:00Z",
      locationId: hall.id,
    });
    await c.s.activities.createSeries(a.ctx, group.id, {
      title: "Träning",
      slots: [{ weekday: 2, startTime: "18:00", durationMinutes: 90 }],
      startsOn: "2026-11-01",
      endsOn: "2026-11-30",
      locationId: hall.id,
    });
    await c.t.db.withTenant(a.ctx, async (tx) => {
      await tx.execute(sql`
        INSERT INTO employments (club_id, person_id, title, employment_type, starts_on)
        VALUES (${a.id}, ${member.id}, 'Administrator', 'hourly', '2026-01-01')`);
      await tx.execute(sql`
        INSERT INTO consents (club_id, person_id, purpose, text_version, given_by_person_id)
        VALUES (${a.id}, ${member.id}, 'photo_publication', 'v1', ${member.id})`);
      await tx.execute(sql`
        INSERT INTO group_waitlist_entries (club_id, group_id, person_id, requested_by_person_id)
        VALUES (${a.id}, ${group.id}, ${family.child.id}, ${family.guardian.id})`);
      await tx.execute(sql`
        INSERT INTO club_phone_numbers (club_id, label, number, sort_order)
        VALUES (${a.id}, 'Kansli', '+46 8 000 00 00', 0)`);
      await tx.execute(sql`
        INSERT INTO join_requests (club_id, person_id, requested_by_person_id)
        VALUES (${a.id}, ${family.child.id}, ${family.guardian.id})`);
      await tx.execute(sql`
        INSERT INTO invitations (club_id, kind, email, token_hash, expires_at, created_by_person_id)
        VALUES (${a.id}, 'email', 'nora@example.test', 'hash', now() + interval '7 days', ${a.manager.id})`);
      await tx.execute(sql`
        INSERT INTO invitation_acceptances (club_id, invitation_id, person_id)
        SELECT ${a.id}, id, ${member.id} FROM invitations WHERE club_id = ${a.id}`);
      await tx.execute(sql`
        INSERT INTO club_manager_reassignments (club_id, person_id, operator_person_id, reason)
        VALUES (${a.id}, ${member.id}, ${family.guardian.id}, 'Board minutes 2026-03')`);
      await tx.execute(sql`
        INSERT INTO member_exports (club_id, requested_by_person_id, columns)
        VALUES (${a.id}, ${a.manager.id}, '{name}')`);
      await tx.execute(sql`
        INSERT INTO support_access_grants (club_id, operator_person_id, granted_by_person_id, reason, expires_at)
        VALUES (${a.id}, ${family.guardian.id}, ${a.manager.id}, 'Import help', now() + interval '1 day')`);
      await tx.execute(sql`
        INSERT INTO member_imports (club_id, created_by_person_id, status, options)
        VALUES (${a.id}, ${a.manager.id}, 'review', '{}')`);
      await tx.execute(sql`
        INSERT INTO member_import_rows (club_id, import_id, row_number, cells)
        SELECT ${a.id}, id, 1, 'sealed' FROM member_imports WHERE club_id = ${a.id}`);
      // Responses and attendance (P1.5) to the match.
      await tx.execute(sql`
        INSERT INTO activity_responses (club_id, activity_id, person_id, status, responded_by_person_id)
        SELECT ${a.id}, id, ${member.id}, 'attending', ${member.id} FROM activities
        WHERE club_id = ${a.id} AND kind = 'match'`);
      await tx.execute(sql`
        INSERT INTO attendance_records (club_id, activity_id, person_id, status, recorded_by_person_id)
        SELECT ${a.id}, id, ${member.id}, 'present', ${a.manager.id} FROM activities
        WHERE club_id = ${a.id} AND kind = 'match'`);
      // A call-up (#19) to the match.
      await tx.execute(sql`
        INSERT INTO activity_invitees (club_id, activity_id, person_id, invited_by_person_id)
        SELECT ${a.id}, id, ${member.id}, ${a.manager.id} FROM activities
        WHERE club_id = ${a.id} AND kind = 'match'`);
    });
    // An event (P1.6) with its group, the match, and a registration.
    const event = await c.s.events.createEvent(a.ctx, {
      title: "Cup",
      audience: "groups",
      groupIds: [group.id],
      startsAt: "2026-11-07T09:00:00Z",
      endsAt: "2026-11-07T16:00:00Z",
      registrationClosesAt: "2026-11-01T20:00:00Z",
      publish: true,
    });
    await c.t.db.withTenant(a.ctx, async (tx) => {
      await tx.execute(sql`
        INSERT INTO event_activities (club_id, event_id, activity_id)
        SELECT ${a.id}, ${event.event.id}, id FROM activities
        WHERE club_id = ${a.id} AND kind = 'match'`);
      await tx.execute(sql`
        INSERT INTO event_registrations (club_id, event_id, person_id, registered_by_person_id, status)
        VALUES (${a.id}, ${event.event.id}, ${member.id}, ${member.id}, 'confirmed')`);
    });

    const { rows: tables } = await c.t.query<{ table_name: string }>(
      "admin",
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'club_id' AND is_nullable = 'NO'
       ORDER BY table_name`,
    );
    expect(tables.length).toBeGreaterThanOrEqual(14);
    const outsider = actor((await buildPerson(c.s)).id, b.id);
    const checkedWrites: string[] = [];

    for (const { table_name: table } of tables) {
      const t = sql.raw(table);
      const { rows: present } = await c.t.query<{ n: number }>(
        "admin",
        `SELECT count(*)::int AS n FROM public.${table} WHERE club_id = $1`,
        [a.id],
      );
      expect(present[0]?.n, `fixture row missing in ${table}`).toBeGreaterThan(0);

      await expectTenantIsolation(c.t.db, b.id, (tx) =>
        tx.execute(sql`SELECT * FROM ${t} WHERE club_id = ${a.id}`),
      );
      const updated = await c.t.db.withTenant(outsider, (tx) =>
        tx.execute(sql`UPDATE ${t} SET updated_at = now() WHERE club_id = ${a.id}`),
      );
      expect(updated.rowCount, `update ${table}`).toBe(0);
      // Moving one of club B's rows into club A is refused by the policy's WITH CHECK.
      const { rows: own } = await c.t.query<{ n: number }>(
        "admin",
        `SELECT count(*)::int AS n FROM public.${table} WHERE club_id = $1`,
        [b.id],
      );
      if (own[0]!.n > 0) {
        await expect(
          c.t.db.withTenant(outsider, (tx) =>
            tx.execute(sql`UPDATE ${t} SET club_id = ${a.id} WHERE club_id = ${b.id}`),
          ),
          `move into ${table}`,
        ).rejects.toMatchObject({ code: "42501" });
        checkedWrites.push(table);
      }
    }

    expect(checkedWrites).toEqual(["club_memberships", "club_profiles", "club_role_assignments"]);
    await expectTenantIsolation(c.t.db, b.id, (tx) =>
      tx.execute(sql`SELECT * FROM clubs WHERE id = ${a.id}`),
    );
  });
});
