// SPDX-License-Identifier: AGPL-3.0-only
import type { PersonSummary } from "@clubadmin/shared";
import { describe, expect, it } from "vitest";

import { wardEntries } from "./ward-labels.ts";

const person = (id: string, first: string): PersonSummary =>
  JSON.parse(
    JSON.stringify({ id, displayName: `${first} Lindqvist`, protected: false }),
  ) as PersonSummary;
const texts = { noClub: "ingen förening", possibleDuplicate: "möjlig dubblett" };

describe("wardEntries", () => {
  it("lists each person once", () => {
    const elsa = { person: person("a", "Elsa"), birthDate: "2017-03-01" };
    expect(wardEntries([elsa, elsa], texts)).toEqual([{ id: "a", label: "Elsa Lindqvist" }]);
  });

  it("tells people with the same name apart by birth year, else club, else as a possible duplicate", () => {
    expect(
      wardEntries(
        [
          { person: person("a", "Elsa"), birthDate: "2017-03-01" },
          { person: person("b", "Elsa"), birthDate: "2015-06-01" },
          { person: person("c", "Oskar"), birthDate: "2012-01-01" },
        ],
        texts,
      ).map((e) => e.label),
    ).toEqual(["Elsa Lindqvist (2017)", "Elsa Lindqvist (2015)", "Oskar Lindqvist"]);
    expect(
      wardEntries(
        [
          { person: person("a", "Elsa"), birthDate: "2017-03-01", clubs: [{ name: "SVK" }] },
          { person: person("b", "Elsa"), birthDate: "2017-03-01", clubs: [] },
        ],
        texts,
      ).map((e) => e.label),
    ).toEqual(["Elsa Lindqvist (SVK)", "Elsa Lindqvist (ingen förening)"]);
    expect(
      wardEntries(
        [
          { person: person("a", "Elsa"), birthDate: null },
          { person: person("b", "Elsa"), birthDate: null },
        ],
        texts,
      ).map((e) => e.label),
    ).toEqual(["Elsa Lindqvist (möjlig dubblett)", "Elsa Lindqvist (möjlig dubblett)"]);
  });
});
