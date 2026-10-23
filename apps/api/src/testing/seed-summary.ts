// SPDX-License-Identifier: AGPL-3.0-only
// A structured summary of a seeded database for the seed tests: clubs,
// groups and every persona's relationships, with IDs replaced by the demo
// data's keys ("generated" for generated people). Independent of the day
// the seed ran (no dates, no names that contain a year).

import type { TestDatabase } from "@clubadmin/db/testing";

import type { DemoData } from "../seed/demodata.ts";

export interface SeedSummary {
  clubs: Record<string, unknown>;
  groups: Record<string, unknown>;
  personas: Record<string, unknown>;
}

export async function summariseSeed(t: TestDatabase, data: DemoData): Promise<SeedSummary> {
  const keyOf = new Map<string, string>(
    [...data.personas, ...data.clubs, ...data.groups].map((x) => [x.id, x.key]),
  );
  const key = (id: string | null) => (id === null ? null : (keyOf.get(id) ?? "generated"));
  const q = async <R extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
    (await t.query<R>("admin", text, values)).rows;

  const clubs: SeedSummary["clubs"] = {};
  for (const c of await q<{
    id: string;
    slug: string;
    country: string;
    join_policy: string;
    default_locale: string;
    time_zone: string;
  }>("SELECT id, slug, country, join_policy, default_locale, time_zone FROM clubs ORDER BY slug")) {
    const members = await q<{ status: string; n: number }>(
      "SELECT status, count(*)::int AS n FROM club_memberships WHERE club_id = $1 GROUP BY status ORDER BY status",
      [c.id],
    );
    const managers = await q<{ person_id: string }>(
      "SELECT person_id FROM club_role_assignments WHERE club_id = $1 AND role = 'club_manager' AND valid_to IS NULL",
      [c.id],
    );
    const handovers = await q<{ from_person_id: string; to_person_id: string; status: string }>(
      "SELECT from_person_id, to_person_id, status FROM club_manager_handovers WHERE club_id = $1 ORDER BY created_at",
      [c.id],
    );
    const joinRequests = await q<{
      person_id: string;
      requested_by_person_id: string;
      status: string;
    }>(
      "SELECT person_id, requested_by_person_id, status FROM join_requests WHERE club_id = $1 ORDER BY person_id",
      [c.id],
    );
    const invitations = await q<{ email: string; group_id: string | null }>(
      "SELECT email, group_id FROM invitations WHERE club_id = $1 AND accepted_at IS NULL ORDER BY email",
      [c.id],
    );
    const grants = await q<{ operator_person_id: string; granted_by_person_id: string }>(
      "SELECT operator_person_id, granted_by_person_id FROM support_access_grants WHERE club_id = $1 AND revoked_at IS NULL AND expires_at > now()",
      [c.id],
    );
    const employments = await q<{ person_id: string; title: string }>(
      "SELECT person_id, title FROM employments WHERE club_id = $1 ORDER BY person_id",
      [c.id],
    );
    const consents = await q<{ person_id: string; purpose: string; given_by_person_id: string }>(
      "SELECT person_id, purpose, given_by_person_id FROM consents WHERE club_id = $1 AND revoked_at IS NULL ORDER BY person_id, purpose",
      [c.id],
    );
    // Activities (P1.4): no dates or session counts (they depend on the day of seeding).
    const locations = await q<{ name: string }>(
      "SELECT name FROM locations WHERE club_id = $1 ORDER BY name",
      [c.id],
    );
    const series = await q<{ title: string; group_ids: string[] }>(
      `SELECT s.title, array_agg(sg.group_id ORDER BY sg.group_id) AS group_ids
       FROM activity_series s JOIN activity_series_groups sg ON sg.series_id = s.id
       WHERE s.club_id = $1 GROUP BY s.id, s.title ORDER BY s.title`,
      [c.id],
    );
    const single = await q<{ kind: string; title: string; group_ids: string[] }>(
      `SELECT a.kind, a.title, array_agg(ag.group_id ORDER BY ag.group_id) AS group_ids
       FROM activities a JOIN activity_groups ag ON ag.activity_id = a.id
       WHERE a.club_id = $1 AND a.series_id IS NULL GROUP BY a.id ORDER BY a.title`,
      [c.id],
    );
    const sessions = await q<{ cancelled: string[]; detached: string[] }>(
      `SELECT coalesce(array_agg(cancelled_reason ORDER BY cancelled_reason) FILTER (WHERE status = 'cancelled'), '{}') AS cancelled,
         coalesce(array_agg(notes ORDER BY notes) FILTER (WHERE detached), '{}') AS detached
       FROM activities WHERE club_id = $1 AND series_id IS NOT NULL`,
      [c.id],
    );
    const groupKeys = (ids: string[]) => ids.map((g) => key(g)).join(" + ");
    clubs[key(c.id)!] = {
      activities: {
        locations: locations.map((l) => l.name),
        series: series.map((x) => `${x.title}: ${groupKeys(x.group_ids)}`),
        single: single.map((x) => `${x.kind} ${x.title}: ${groupKeys(x.group_ids)}`),
        cancelledSessions: sessions[0]?.cancelled ?? [],
        detachedSessions: sessions[0]?.detached ?? [],
      },
      joinRequests: joinRequests.map(
        (j) => `${key(j.person_id)} by ${key(j.requested_by_person_id)}: ${j.status}`,
      ),
      invitations: invitations.map((i) => `${i.email}${i.group_id ? ` → ${key(i.group_id)}` : ""}`),
      supportGrants: grants.map(
        (g) => `${key(g.operator_person_id)} by ${key(g.granted_by_person_id)}`,
      ),
      employments: employments.map((e) => `${key(e.person_id)}: ${e.title}`),
      consents: consents.map(
        (x) => `${key(x.person_id)}: ${x.purpose} by ${key(x.given_by_person_id)}`,
      ),
      slug: c.slug,
      country: c.country,
      locale: c.default_locale,
      timeZone: c.time_zone,
      joinPolicy: c.join_policy,
      managers: managers.map((m) => key(m.person_id)).sort(),
      memberships: Object.fromEntries(members.map((m) => [m.status, m.n])),
      handovers: handovers.map(
        (h) => `${key(h.from_person_id)} → ${key(h.to_person_id)}: ${h.status}`,
      ),
    };
  }

  const groups: SeedSummary["groups"] = {};
  for (const g of await q<{
    id: string;
    kind: string;
    parent: string | null;
    capacity: number | null;
    admission_mode: string;
  }>(
    "SELECT id, kind, parent_group_id AS parent, capacity, admission_mode FROM groups ORDER BY id",
  )) {
    const members = await q<{ person_id: string; function: string }>(
      "SELECT person_id, function FROM group_memberships WHERE group_id = $1 AND valid_to IS NULL ORDER BY person_id, function",
      [g.id],
    );
    const owners = await q<{ person_id: string }>(
      "SELECT person_id FROM group_owners WHERE group_id = $1 AND valid_to IS NULL",
      [g.id],
    );
    const waiting = await q<{ status: string; n: number }>(
      "SELECT status, count(*)::int AS n FROM group_waitlist_entries WHERE group_id = $1 GROUP BY status ORDER BY status",
      [g.id],
    );
    const queue = await q<{ person_id: string }>(
      "SELECT person_id FROM group_waitlist_entries WHERE group_id = $1 AND status = 'waiting' ORDER BY priority DESC, queued_at",
      [g.id],
    );
    groups[key(g.id)!] = {
      queue: queue.map((w) => key(w.person_id)),
      kind: g.kind,
      parent: key(g.parent),
      capacity: g.capacity,
      admission: g.admission_mode,
      owners: owners.map((o) => key(o.person_id)).sort(),
      named: members
        .filter((m) => key(m.person_id) !== "generated")
        .map((m) => `${key(m.person_id)}${m.function === "member" ? "" : ` (${m.function})`}`)
        .sort(),
      generated: members.filter((m) => key(m.person_id) === "generated").length,
      waitlist: Object.fromEntries(waiting.map((w) => [w.status, w.n])),
    };
  }

  const personas: SeedSummary["personas"] = {};
  for (const p of data.personas) {
    const [person] = await q<{ protected_identity: boolean; birth_date: string | null }>(
      "SELECT protected_identity, birth_date::text FROM people WHERE id = $1",
      [p.id],
    );
    if (!person) {
      personas[p.key] = { person: false };
      continue;
    }
    const [account] = await q<{ email: string; locale: string | null }>(
      "SELECT email, locale FROM accounts WHERE person_id = $1",
      [p.id],
    );
    const memberships = await q<{ club_id: string; status: string; membership_type: string }>(
      "SELECT club_id, status, membership_type FROM club_memberships WHERE person_id = $1 ORDER BY club_id, valid_from",
      [p.id],
    );
    const roles = await q<{ club_id: string; role: string; current: boolean }>(
      "SELECT club_id, role, valid_to IS NULL AS current FROM club_role_assignments WHERE person_id = $1 ORDER BY club_id, role, valid_from",
      [p.id],
    );
    const inGroups = await q<{ group_id: string; function: string; current: boolean }>(
      "SELECT group_id, function, valid_to IS NULL AS current FROM group_memberships WHERE person_id = $1 ORDER BY group_id, valid_from",
      [p.id],
    );
    const guardians = await q<{
      guardian_person_id: string;
      kind: string;
      status: string;
      rights: string[];
    }>(
      "SELECT guardian_person_id, kind, status, rights FROM guardianships WHERE ward_person_id = $1 ORDER BY guardian_person_id",
      [p.id],
    );
    const pending = await q<{ email: string }>(
      "SELECT email FROM guardian_invitations WHERE ward_person_id = $1 AND accepted_at IS NULL",
      [p.id],
    );
    const flagged = await q<{ club_id: string }>(
      "SELECT club_id FROM club_profiles WHERE person_id = $1 AND protected_identity_club",
      [p.id],
    );
    personas[p.key] = {
      account: account ? { email: account.email, locale: account.locale } : null,
      hasBirthDate: person.birth_date !== null,
      protected: person.protected_identity,
      clubProtected: flagged.map((f) => key(f.club_id)),
      memberships: memberships.map((m) => `${key(m.club_id)}: ${m.status} (${m.membership_type})`),
      roles: roles.map((r) => `${key(r.club_id)}: ${r.role}${r.current ? "" : " (ended)"}`),
      groups: inGroups.map(
        (g) => `${key(g.group_id)}: ${g.function}${g.current ? "" : " (ended)"}`,
      ),
      guardians: guardians.map(
        (g) => `${key(g.guardian_person_id)}: ${g.kind} ${g.status} [${g.rights.join(", ")}]`,
      ),
      pendingGuardianInvitations: pending.length,
    };
  }
  return { clubs, groups, personas };
}
