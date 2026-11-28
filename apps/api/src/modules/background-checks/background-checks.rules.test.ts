// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  clubRules,
  coverage,
  overviewStatus,
  type PluginDeclarations,
  weakerCategory,
  weakerThanPlugin,
} from "./background-checks.rules.ts";

const SE: PluginDeclarations = {
  pluginId: "se.rf.registerutdrag",
  regions: ["SE"],
  types: [
    {
      key: "extract",
      name: "x",
      initiator: "person",
      maxAgeDaysWhenPresented: 183,
      recheckMonths: null,
      minAge: 15,
      copyRetention: "none",
      methods: ["viewed"],
      cost: null,
      integration: "none",
    },
  ],
  requirements: [
    {
      category: "regular_contact_with_children",
      checkType: "extract",
      level: "required",
      basis: "b",
    },
    { category: "board", checkType: "extract", level: "recommended", basis: "b" },
  ],
};
const record = (issuedOn: string, validUntil: string | null = null) => ({
  id: issuedOn,
  pluginId: SE.pluginId,
  checkType: "extract",
  issuedOn,
  validUntil,
});

describe("club rules", () => {
  it("take the plugin of the country's required ones", () => {
    const r = clubRules([SE], "SE", [], []);
    expect(r.active).toBe(true);
    expect(r.rules.map((x) => x.category)).toEqual(["regular_contact_with_children"]);
    expect(clubRules([SE], "NO", [], [])).toEqual({ pluginId: null, active: false, rules: [] });
  });

  it("lift everything when the club turned the plugin off", () => {
    expect(clubRules([SE], "SE", [SE.pluginId], [])).toMatchObject({ active: false, rules: [] });
  });

  it("raise a recommended one and set a re-check interval where the plugin has none", () => {
    const r = clubRules(
      [SE],
      "SE",
      [],
      [
        { pluginId: SE.pluginId, category: "board", checkType: "extract", recheckMonths: null },
        {
          pluginId: SE.pluginId,
          category: "regular_contact_with_children",
          checkType: "extract",
          recheckMonths: 36,
        },
      ],
    );
    expect(r.rules).toEqual([
      {
        category: "regular_contact_with_children",
        pluginId: SE.pluginId,
        checkType: "extract",
        recheckMonths: 36,
      },
      { category: "board", pluginId: SE.pluginId, checkType: "extract", recheckMonths: null },
    ]);
  });

  it("never weaken: a longer interval than the plugin's or a milder duty category is refused", () => {
    const withInterval = { ...SE, types: [{ ...SE.types[0]!, recheckMonths: 12 }] };
    const add = { pluginId: SE.pluginId, category: "board" as const, checkType: "extract" };
    expect(weakerThanPlugin(withInterval, { ...add, recheckMonths: 24 })).toBe(true);
    expect(weakerThanPlugin(withInterval, { ...add, recheckMonths: 6 })).toBe(false);
    expect(weakerCategory("alone_with_children", "regular_contact_with_children")).toBe(true);
    expect(weakerCategory("regular_contact_with_children", "alone_with_children")).toBe(false);
  });
});

describe("coverage", () => {
  const rules = clubRules(
    [SE],
    "SE",
    [],
    [
      {
        pluginId: SE.pluginId,
        category: "regular_contact_with_children",
        checkType: "extract",
        recheckMonths: 36,
      },
    ],
  );
  const cats = ["regular_contact_with_children"] as const;

  it("is not required without a needing role, or with the plugin off", () => {
    expect(coverage(rules, ["board"], [], "2026-11-28")).toEqual({ status: "not_required" });
    expect(coverage(clubRules([SE], "SE", [SE.pluginId], []), cats, [], "2026-11-28").status).toBe(
      "not_required",
    );
  });

  it("is missing without a record, or with one past the club's interval", () => {
    expect(coverage(rules, cats, [], "2026-11-28").status).toBe("missing");
    expect(coverage(rules, cats, [record("2023-11-27")], "2026-11-28").status).toBe("missing");
  });

  it("is valid until the interval ends, and expiring before that", () => {
    const c = coverage(rules, cats, [record("2023-12-15")], "2026-11-28");
    expect(c).toEqual({ status: "valid", expiresOn: "2026-12-15" });
    expect(overviewStatus(c, true, "2026-11-28", 60)).toBe("expiring");
    const fresh = coverage(rules, cats, [record("2026-10-01")], "2026-11-28");
    expect(overviewStatus(fresh, true, "2026-11-28", 60)).toBe("valid");
    expect(overviewStatus({ status: "not_required" }, true, "2026-11-28", 60)).toBe("to_delete");
  });
});
