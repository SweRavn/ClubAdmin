// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { csvCell, csvRow } from "./csv.ts";

describe("csv", () => {
  it("quotes separators, quotes and line breaks", () => {
    expect(csvCell('Anna "Ankan" Berg')).toBe('"Anna ""Ankan"" Berg"');
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("rad 1\nrad 2")).toBe('"rad 1\nrad 2"');
    expect(csvCell(null)).toBe("");
    expect(csvRow(["a", 1, null])).toBe("a,1,\r\n");
  });

  it("neutralises formulas", () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"');
    expect(csvCell("+46 70 123 45 67")).toBe("'+46 70 123 45 67");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    // Numbers we write ourselves stay numbers.
    expect(csvCell(-1)).toBe("-1");
  });
});
