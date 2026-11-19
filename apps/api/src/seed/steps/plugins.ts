// SPDX-License-Identifier: AGPL-3.0-only
// Demo data for grant plugins (P2.7 part B, ADR 0051, docs/seed-data.md):
// Anna enabled the LOK-stöd plugin for SVK a month ago (its youth sessions
// then show what counts, and the attendance views the hints), and Lars the
// samordnet rapportering plugin for FIL. Written in the club as the
// manager, with the audit event the plugins service records.

import { audit, sql } from "@clubadmin/db";

import type { DemoStep } from "../environment.ts";

const ENABLED = [
  { club: "svk", manager: "anna", pluginId: "se.rf.lok" },
  { club: "fil", manager: "lars", pluginId: "no.nif.samordnet" },
] as const;

export const pluginsDemoStep: DemoStep = {
  name: "plugins",
  async run(env, _data, core) {
    const id = (key: string) => {
      const found = core.ids.get(key);
      if (!found) throw new Error(`plugins seed: unknown key ${key}`);
      return found;
    };
    for (const entry of ENABLED) {
      const clubId = id(entry.club);
      await env.db.withTenant(
        {
          actorKind: "person",
          personId: id(entry.manager),
          clubId,
          requestId: "seed:plugins",
          seedTime: env.clock.at("-1mo"),
        },
        async (tx) => {
          await tx.execute(sql`
            INSERT INTO public.club_plugins (club_id, plugin_id, enabled)
            VALUES (${clubId}, ${entry.pluginId}, true)`);
          await audit.record(tx, {
            action: "plugin.enabled",
            resourceType: "club",
            resourceId: clubId,
            changedFields: [entry.pluginId],
          });
        },
      );
    }
  },
};
