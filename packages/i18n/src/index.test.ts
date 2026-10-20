// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { catalogues, negotiateLocale, translate } from "./index.ts";

describe("catalogues", () => {
  it("have the same keys in every language", () => {
    expect(Object.keys(catalogues.sv).sort()).toEqual(Object.keys(catalogues.en).sort());
  });
});

describe("negotiateLocale", () => {
  it.each([
    [undefined, "en"],
    ["", "en"],
    ["sv-SE,sv;q=0.9,en;q=0.8", "sv"],
    ["en-GB,en;q=0.9", "en"],
    ["de-DE,sv;q=0.5", "sv"],
    ["nb-NO,nb;q=0.9", "en"],
    ["en;q=0.4,sv;q=0.6", "sv"],
    ["sv;q=0", "en"],
  ])("%s → %s", (header, expected) => {
    expect(negotiateLocale(header)).toBe(expected);
  });
});

describe("translate", () => {
  it("returns the message in the requested language", () => {
    expect(translate("sv", "problem.not-found")).toBe("Hittades inte");
    expect(translate("en", "problem.not-found")).toBe("Not found");
  });
});
