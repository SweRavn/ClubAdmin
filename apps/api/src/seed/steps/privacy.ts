// SPDX-License-Identifier: AGPL-3.0-only
// Demo privacy (P1.8a, docs/seed-data.md), through the services with the
// personas as actors:
// - SVK's board decided the former-member period (24 months) and the
//   consents asked (photo, video, contact details to the team and to the
//   club) three months ago, so its policy is version 2; IKN's board decided
//   photo, streaming and marketing a year ago; FIL uses the defaults.
// - SVK published its own photo text: version 1 a year ago, version 2 last
//   month (reconfirm off): Anna's consent for Elsa, given for version 1,
//   shows "the club has a new text".
// - Anna shows her phone to Elsa's team (contacts_group); Mikael does not.
// - Oskar (14) gave his own photo consent in IKN and withdrew streaming.
// - Johan (registrar) recorded a paper consent for an F2017 player.
// - A Herr senior player left SVK last week and removed their contact
//   details at once (the worker purges them when it runs).
// - Two generated people without login are orphaned: one 40 months ago
//   (erased by the first privacy:retention run), one 6 months ago.
// Runs before the notifications step, which marks the seed's events as
// handled (they are history, not news).

import { sql } from "@clubadmin/db";

import type { DemoStep } from "../environment.ts";

/** Fixed IDs (the seed is deterministic) outside the personas' and generated ranges. */
const ORPHANS = ["0199a000-0000-7000-8300-000000000001", "0199a000-0000-7000-8300-000000000002"];

export const privacyDemoStep: DemoStep = {
  name: "privacy",
  async run(env, _data, core) {
    const s = env.services;
    const id = (key: string) => {
      const value = core.ids.get(key);
      if (!value) throw new Error(`no id for ${key}`);
      return value;
    };
    const actorIn = (person: string, club: string, at: Parameters<typeof env.clock.at>[0]) => ({
      actorKind: "person" as const,
      personId: id(person),
      clubId: id(club),
      requestId: "seed",
      seedTime: env.clock.at(at),
    });
    const svk = id("svk");
    const ikn = id("ikn");

    // Board decisions (recorded by the club managers).
    await s.clubPrivacy.recordDecision(actorIn("sara", "svk", "-3mo"), {
      body: "board",
      decidedOn: env.clock.day("-3mo"),
      reference: "§ 7",
      settings: {
        former_member_retention_months: 24,
        consent_purposes: [
          "photo_publication",
          "video_publication",
          "contacts_group",
          "contacts_club",
        ],
      },
    });
    await s.clubPrivacy.recordDecision(actorIn("karin", "ikn", "-1y"), {
      body: "board",
      decidedOn: env.clock.day("-1y"),
      reference: "§ 12",
      settings: { consent_purposes: ["photo_publication", "streaming", "marketing"] },
    });

    // SVK's own photo text, two versions.
    await s.consents.publishText(actorIn("sara", "svk", "-1y"), {
      purpose: "photo_publication",
      texts: {
        sv: "Sörbyns VK får publicera bilder där du (eller ditt barn) syns, på vkweb.se, i föreningens Instagram och i matchprogrammet. Namn skrivs aldrig ut. Du kan när som helst ta tillbaka samtycket.",
      },
    });
    await s.consents.publishText(actorIn("sara", "svk", "-1mo"), {
      purpose: "photo_publication",
      texts: {
        sv: "Sörbyns VK får publicera bilder där du (eller ditt barn) syns, på vkweb.se, i föreningens Instagram, Facebook och i matchprogrammet. Namn skrivs aldrig ut. Du kan när som helst ta tillbaka samtycket.",
        en: "Sörbyns VK may publish photos in which you (or your child) appear, on vkweb.se, in the club's Instagram and Facebook and in the match programme. Names are never printed. You can withdraw this consent at any time.",
      },
    });
    // The consents of the core step were given for SVK's first version; dates as published.
    await env.admin(`
      UPDATE public.consent_texts SET published_at = now() - interval '1 year', created_at = now() - interval '1 year'
      WHERE club_id = '${svk}' AND version = 1;
      UPDATE public.consent_texts SET published_at = now() - interval '1 month', created_at = now() - interval '1 month'
      WHERE club_id = '${svk}' AND version = 2;
      UPDATE public.consents SET text_version = 'club:1'
      WHERE club_id = '${svk}' AND purpose = 'photo_publication' AND revoked_at IS NULL;`);

    await s.consents.give(actorIn("anna", "svk", "-2mo"), "self", id("anna"), "contacts_group", {
      textVersion: "default:1",
    });
    await s.consents.give(
      actorIn("oskar", "ikn", "-6mo"),
      "self",
      id("oskar"),
      "photo_publication",
      {
        textVersion: "default:1",
      },
    );
    await s.consents.give(actorIn("oskar", "ikn", "-6mo"), "self", id("oskar"), "streaming", {
      textVersion: "default:1",
    });
    await s.consents.withdraw(actorIn("oskar", "ikn", "-1mo"), "self", id("oskar"), "streaming");

    const f2017 = core.generated.get("svk-f2017") ?? [];
    if (f2017[0]) {
      await s.consents.give(
        actorIn("johan", "svk", "-2mo"),
        "admin",
        f2017[0],
        "photo_publication",
        {
          textVersion: "club:2",
          clubNote: "Pappersblankett augusti",
        },
      );
    }

    // A Herr senior player leaves SVK and removes their contact details at once.
    const herr = core.generated.get("svk-herr") ?? [];
    const leaver = herr.at(-1);
    if (leaver) {
      const { rows } = await env.db.withSystem("seed:privacy", { clubId: svk }, (tx) =>
        tx.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM public.group_memberships
          WHERE club_id = ${svk} AND person_id = ${leaver} AND valid_to IS NULL AND function <> 'member'`),
      );
      if ((rows[0]?.n ?? 0) === 0) {
        await s.leaving.leave(
          {
            actorKind: "person",
            personId: leaver,
            clubId: svk,
            requestId: "seed",
            seedTime: env.clock.at("-7d"),
          },
          leaver,
          { removeNow: true },
        );
      }
    }

    // Orphaned people without login (their club data purged long ago).
    await env.admin(`
      INSERT INTO public.people (id, given_name, family_name, birth_date, orphaned_since)
      VALUES ('${ORPHANS[0]}', 'Gammal', 'Medlem', '1990-03-03', now() - interval '40 months'),
             ('${ORPHANS[1]}', 'Nyligen', 'Medlem', '1992-05-05', now() - interval '6 months');`);
    void ikn;
  },
};
