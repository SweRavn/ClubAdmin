// SPDX-License-Identifier: AGPL-3.0-only
// Demo calendar subscriptions (P1.11, docs/seed-data.md) with fixed demo
// secrets, so a calendar app (or curl) can fetch them at once:
// - Anna: "My schedule" with Elsa and Oskar (both clubs): /cal/demo-anna-my-schedule.ics
// - Erik: SVK F2017's group calendar: /cal/demo-erik-f2017.ics
// - Ahmed: a feed for himself, and one he removed a month ago (its URL answers 404)
// The demo answer link ("Elsa is coming" to her next F2017 training) is
// printed when CALENDAR_TOKEN_KEY is set. Rows are written as the persona,
// so history and audit name them.

import { createHash } from "node:crypto";

import { audit, sql } from "@clubadmin/db";
import { calendarAnswerToken } from "@clubadmin/server-kit/calendar";

import type { DemoStep } from "../environment.ts";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export const calendarDemoStep: DemoStep = {
  name: "calendar",
  async run(env, _data, core) {
    const id = (key: string) => {
      const found = core.ids.get(key);
      if (!found) throw new Error(`calendar seed: unknown key ${key}`);
      return found;
    };
    const feed = async (
      persona: string,
      secret: string,
      values: {
        scope: string;
        clubId?: string;
        groupId?: string;
        personIds?: string[];
        label?: string;
      },
      revokedAgo?: string,
    ): Promise<string> => {
      const personId = id(persona);
      return env.db.withActor(
        {
          actorKind: "person",
          personId,
          requestId: "seed:calendar",
          seedTime: env.clock.at("-2mo"),
        },
        async (tx) => {
          const { rows } = await tx.execute<{ id: string }>(sql`
            INSERT INTO public.calendar_feeds (person_id, scope, club_id, group_id, person_ids, label, token_hash,
              revoked_at, revoked_reason, last_fetched_at)
            VALUES (${personId}, ${values.scope}, ${values.clubId ?? null}, ${values.groupId ?? null},
              ${`{${(values.personIds ?? []).join(",")}}`}::uuid[], ${values.label ?? null}, ${sha256(secret)},
              ${revokedAgo ? env.clock.at(revokedAgo) : null}, ${revokedAgo ? "owner" : null},
              ${revokedAgo ? null : env.clock.at("-1d")})
            RETURNING id`);
          const feedId = rows[0]!.id;
          await audit.record(tx, {
            action: "calendar_feed.created",
            resourceType: "calendar_feed",
            resourceId: feedId,
            changedFields: ["scope"],
          });
          if (revokedAgo) {
            await audit.record(tx, {
              action: "calendar_feed.revoked",
              resourceType: "calendar_feed",
              resourceId: feedId,
              changedFields: ["revoked_at", "revoked_reason"],
            });
          }
          return feedId;
        },
      );
    };
    const anna = await feed("anna", "demo-anna-my-schedule", {
      scope: "my_schedule",
      personIds: [id("elsa"), id("oskar")],
      label: "Familjen",
    });
    await feed("erik", "demo-erik-f2017", {
      scope: "group",
      clubId: id("svk"),
      groupId: id("svk-f2017"),
    });
    await feed("ahmed", "demo-ahmed-my-schedule", { scope: "my_schedule" });
    await feed("ahmed", "demo-ahmed-removed", { scope: "my_schedule" }, "-1mo");

    const log = env.log ?? (() => undefined);
    log("calendar feed (anna): /cal/demo-anna-my-schedule.ics");
    log("calendar feed (erik, F2017): /cal/demo-erik-f2017.ics");
    if (env.calendarTokenKey) {
      // Elsa's next F2017 training, as an answer link from Anna's feed.
      const next = await env.db.withSystem("seed:calendar", { clubId: id("svk") }, async (tx) => {
        const { rows } = await tx.execute<{ activity_id: string }>(sql`
          SELECT se.activity_id FROM public.schedule_entries se
          WHERE se.group_id = ${id("svk-f2017")} AND se.kind = 'training' AND se.status = 'scheduled'
            AND se.starts_at > now()
          ORDER BY se.starts_at LIMIT 1`);
        return rows[0]?.activity_id ?? null;
      });
      if (next) {
        const token = calendarAnswerToken(env.calendarTokenKey, {
          feedId: anna,
          activityId: next,
          personId: id("elsa"),
          status: "attending",
        });
        log(`calendar answer link (Elsa is coming): /answer/${token}`);
      }
    }
  },
};
