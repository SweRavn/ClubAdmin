// SPDX-License-Identifier: AGPL-3.0-only
// Background checks (P2.8, docs/seed-data.md): the plugins of Sweden and
// Norway are on by default.
// - SVK: Erik, Sara and Johan (F2017's leaders) have valid extracts.
// - IKN re-checks every 36 months (its stricter requirement). In P2012,
//   Ahmed and Peter are valid, Tilde's extract (35 months old) expires within
//   weeks, and Göran (a new assistant coach) has none: he cannot write to
//   the children or take the "Sekretariat" shifts. Erik (F2015) is valid.
// - Fjordvik IL (Norway): Lars has shown his politiattest; for Kari, the new
//   team manager of J2014, the club has confirmed the purpose (a request in
//   progress).
// Records are written as the club's registrar or manager would tick them
// off (no plugin call in the seed).

import type { TenantContext } from "@clubadmin/db";

import * as repo from "../../modules/background-checks/background-checks.repository.ts";
import type { DemoStep } from "../environment.ts";

const DAY_MS = 86_400_000;

export const backgroundChecksDemoStep: DemoStep = {
  name: "background-checks",
  async run(env, _data, core) {
    const id = (key: string) => {
      const found = core.ids.get(key);
      if (!found) throw new Error(`background-checks seed: unknown key ${key}`);
      return found;
    };
    const s = env.services;
    const as = (persona: string, club: string): TenantContext => ({
      actorKind: "person",
      personId: id(persona),
      clubId: id(club),
      requestId: "seed:background-checks",
    });
    const ago = (days: number) =>
      new Date(env.clock.now.getTime() - days * DAY_MS).toISOString().slice(0, 10);
    const se = (verifier: string, club: string, person: string, days: number) =>
      s.checks.recordDirect(as(verifier, club), {
        personId: id(person),
        pluginId: "se.rf.registerutdrag",
        checkType: "extract",
        issuingCountry: "SE",
        issuedOn: ago(days),
      });

    // SVK: the registrar (Anna) saw F2017's leaders' extracts.
    await se("anna", "svk", "erik", 120);
    await se("anna", "svk", "sara", 300);
    await se("anna", "svk", "johan", 45);

    // IKN: a new check every 36 months; Karin (club manager) follows up.
    await s.checks.putRequirements(as("karin", "ikn"), {
      clubRequirements: [
        {
          pluginId: "se.rf.registerutdrag",
          category: "regular_contact_with_children",
          checkType: "extract",
          recheckMonths: 36,
        },
      ],
    });
    await se("karin", "ikn", "ahmed", 400);
    await se("karin", "ikn", "peter", 200);
    await se("karin", "ikn", "erik", 150);
    // 35 months ago: due again within the expiring window.
    await se("karin", "ikn", "tilde", 1045);

    // Fjordvik IL: Lars's attest shown digitally; Kari's request in progress.
    await s.checks.recordDirect(as("kari", "fil"), {
      personId: id("lars"),
      pluginId: "no.nif.politiattest",
      checkType: "attest",
      issuingCountry: "NO",
      issuedOn: ago(600),
      method: "digital_mailbox",
    });
    await env.db.withTenant(as("lars", "fil"), (tx) =>
      repo.insertRequest(tx, id("fil"), {
        personId: id("kari"),
        pluginId: "no.nif.politiattest",
        checkType: "attest",
        status: "requested",
        reference: `purpose-${id("kari")}-${ago(5)}`,
        requestedByPersonId: id("lars"),
      }),
    );
  },
};
