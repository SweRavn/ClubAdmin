// SPDX-License-Identifier: AGPL-3.0-only
// The retention registry (packages/shared retention.ts, P1.8a) and the
// documentation say the same: every rule is in the table of docs/gdpr.md
// (marked "retention: `key`") and every marked row is a rule; every task a
// rule names exists in the worker; planned rules are marked planned.

import { readFileSync } from "node:fs";

import { RETENTION_RULES } from "@clubadmin/shared";
import { describe, expect, it } from "vitest";

import { createTaskList } from "./tasks/index.ts";

const gdpr = readFileSync(new URL("../../../docs/gdpr.md", import.meta.url), "utf8");
const table = gdpr.slice(
  gdpr.indexOf("## Retention defaults"),
  gdpr.indexOf("## Protected identity"),
);
const documented = new Map(
  [...table.matchAll(/retention: `([a-z_]+)`(, planned)?/g)].map((m) => [m[1]!, Boolean(m[2])]),
);

describe("retention registry", () => {
  it("lists every rule in docs/gdpr.md and nothing else", () => {
    expect([...documented.keys()].sort()).toEqual(RETENTION_RULES.map((r) => r.key).sort());
  });

  it("marks planned rules as planned in both", () => {
    for (const rule of RETENTION_RULES) {
      expect(documented.get(rule.key), rule.key).toBe(rule.status === "planned");
    }
  });

  it("names only tasks the worker has", () => {
    const tasks = createTaskList({
      db: {} as never,
      outboxHandlers: [],
      historyRetentionMonths: 24,
      historyPartitionsAhead: 3,
      // Billing jobs exist only with billing on (accounting_records).
      billing: { settings: {} as never, send: { mail: null, webUrl: "", emailLink: false } },
    });
    for (const rule of RETENTION_RULES.filter((r) => r.task)) {
      expect(tasks[rule.task!], `${rule.key}: ${rule.task}`).toBeTypeOf("function");
    }
  });
});
