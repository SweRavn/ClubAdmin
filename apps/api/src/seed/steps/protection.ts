// SPDX-License-Identifier: AGPL-3.0-only
// Demo data for protected identity and the profile view log (P1.12,
// docs/seed-data.md):
// - IKN: Erik (F2015 assistant coach) opened Nadia's profile twice last
//   week, Karin (manager) once yesterday; Karin opened Samira's once.
//   Samira sees it in Nadia's access log, Karin in IKN's log.
// - SVK logs every profile view (set by Anna): Johan opened Elsa's and
//   Alva's profiles last week; Johan and Sara each opened the protected
//   SVK Herr senior player once. Ola, who left SVK, opened Elsa's profile
//   before leaving and appears only as "a former member" (ledger entry).
// - Anna set and removed club protection on Lars last year (history).
// Rows are written in the club as the viewer, backdated.

import { audit, type Database, sql } from "@clubadmin/db";

import type { DemoStep } from "../environment.ts";

export const protectionDemoStep: DemoStep = {
  name: "protection",
  async run(env, _data, core) {
    const id = (key: string) => {
      const found = core.ids.get(key);
      if (!found) throw new Error(`protection seed: unknown key ${key}`);
      return found;
    };
    const svk = id("svk");
    const ikn = id("ikn");
    const db: Database = env.db;
    const view = (
      club: string,
      viewer: string,
      viewed: string,
      ago: string,
      options: { count?: number; protected?: boolean } = {},
    ) =>
      db.withTenant(
        { actorKind: "person", personId: id(viewer), clubId: club, requestId: "seed:protection" },
        (tx) => {
          const at = env.clock.at(ago);
          return tx.execute(sql`
            INSERT INTO public.profile_views (club_id, viewed_person_id, viewer_person_id, viewer_kind,
              surface, protected, day, first_viewed_at, last_viewed_at, view_count)
            VALUES (${club}, ${viewed}, ${id(viewer)}, 'person', 'profile',
              ${options.protected ?? true}, ${at.toISOString().slice(0, 10)}::date, ${at}, ${at},
              ${options.count ?? 1})`);
        },
      );

    // IKN: views of the protected family.
    await view(ikn, "erik", id("nadia"), "-6d", { count: 2 });
    await view(ikn, "karin", id("nadia"), "-1d");
    await view(ikn, "karin", id("samira"), "-1d");

    // SVK logs every view (Anna's decision).
    await db.withTenant(
      { actorKind: "person", personId: id("anna"), clubId: svk, requestId: "seed:protection" },
      async (tx) => {
        await tx.execute(
          sql`UPDATE public.clubs SET profile_view_logging = 'all' WHERE id = ${svk}`,
        );
        await audit.record(tx, {
          action: "club.settings.updated",
          resourceType: "club",
          resourceId: svk,
          changedFields: ["profile_view_logging"],
        });
      },
    );
    await view(svk, "johan", id("elsa"), "-5d", { protected: false });
    await view(svk, "johan", id("alva"), "-5d", { protected: false });
    const protectedPlayer = await db.withSystem("seed:protection", { clubId: svk }, async (tx) => {
      const { rows } = await tx.execute<{ person_id: string }>(sql`
        SELECT person_id FROM public.club_profiles
        WHERE club_id = ${svk} AND protected_identity_club ORDER BY member_number LIMIT 1`);
      return rows[0]?.person_id ?? null;
    });
    if (protectedPlayer) {
      await view(svk, "johan", protectedPlayer, "-3d");
      await view(svk, "sara", protectedPlayer, "-2d");
    }
    // Ola left SVK: the log keeps the view as "a former member".
    await view(svk, "ola", id("elsa"), "-8mo", { protected: false });
    await db.withSystem("seed:protection", { clubId: svk }, (tx) =>
      tx.execute(sql`SELECT privacy.anonymize_profile_views(${id("ola")}, ${svk}, true)`),
    );

    // History: Anna protected Lars in the club last year, then removed it.
    const asAnna = (ago: string) => ({
      actorKind: "person" as const,
      personId: id("anna"),
      clubId: svk,
      requestId: "seed:protection",
      seedTime: env.clock.at(ago),
    });
    await env.services.profiles.setClubProtection(asAnna("-1y"), id("lars"), true);
    await env.services.profiles.setClubProtection(asAnna("-11mo"), id("lars"), false);
  },
};
