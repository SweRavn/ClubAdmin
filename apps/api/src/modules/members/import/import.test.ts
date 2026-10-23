// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";

import { MemberImportOptionsSchema } from "@clubadmin/shared";
import { describe, expect, it } from "vitest";

import { importBatches, rowStatus } from "../member-imports.service.ts";
import { CsvError, decodeCsv, detectDelimiter, parseCsv } from "./csv.ts";
import { suggestMapping } from "./headers.ts";
import { columnsOf, mapRow, type RowRules } from "./rows.ts";
import { parseDate, parseGender, parseKind, splitFullName } from "./values.ts";

const SAMPLE = new URL("../../../../../../docs/demodata/imports/medlemmar.csv", import.meta.url);

describe("CSV", () => {
  it("decodes UTF-8 with a BOM and Windows-1252", () => {
    expect(decodeCsv(new Uint8Array([0xef, 0xbb, 0xbf, 0x41, 0xc3, 0xa5]))).toBe("Aå");
    // "Åsa" in Windows-1252.
    expect(decodeCsv(new Uint8Array([0xc5, 0x73, 0x61]))).toBe("Åsa");
  });

  it("detects the separator and parses quoted cells", () => {
    expect(detectDelimiter("a;b;c\n1,2;3")).toBe(";");
    expect(detectDelimiter('"a;b",c,d')).toBe(",");
    expect(
      parseCsv('Namn;Note\r\n"Svensson; Anna";"Sa ""hej""\nrad 2"\r\n\r\nB;=1+1\n', {
        maxRows: 10,
      }),
    ).toEqual([
      ["Namn", "Note"],
      ["Svensson; Anna", 'Sa "hej"\nrad 2'],
      ["B", "=1+1"],
    ]);
  });

  it("fails with a code on malformed and too long files", () => {
    expect(() => parseCsv('a;b\n"open', { maxRows: 10 })).toThrow(CsvError);
    expect(() => parseCsv("a\n1\n2\n3", { maxRows: 2 })).toThrow(
      expect.objectContaining({ code: "import_file_too_large" }) as unknown,
    );
    expect(() => parseCsv("only a header", { maxRows: 2 })).toThrow(CsvError);
  });
});

describe("values", () => {
  it("parses dates in ISO, the country's order, and unambiguous slashes", () => {
    expect(parseDate("2017-04-02", "dmy")).toBe("2017-04-02");
    expect(parseDate("20170402", "dmy")).toBe("2017-04-02");
    expect(parseDate("02.04.2017", "dmy")).toBe("2017-04-02");
    expect(parseDate("02.04.2017", "mdy")).toBe("2017-02-04");
    expect(parseDate("13/4/2017", "dmy")).toBe("2017-04-13");
    expect(parseDate("2/4/2017", "dmy")).toBeNull();
    expect(parseDate("31.02.2017", "dmy")).toBeNull();
  });

  it("reads genders, kinds and names in sv, en and nb", () => {
    expect(parseGender("Flicka")).toBe("female");
    expect(parseGender("gutt")).toBe("male");
    expect(parseKind("Bonuspappa")).toBe("step_parent");
    expect(parseKind("Familjehem")).toBe("foster_parent");
    expect(parseKind("Morfar")).toBe("relative");
    expect(parseKind("")).toBe("parent");
    expect(parseKind("granne")).toBeNull();
    expect(splitFullName("Anna Maria Svensson")).toEqual(["Anna Maria", "Svensson"]);
    expect(splitFullName("Svensson, Anna")).toEqual(["Anna", "Svensson"]);
  });
});

describe("headers", () => {
  it("recognises sv, en and nb headers and any number of guardians", () => {
    const { columnMap } = suggestMapping(
      [
        "Förnamn",
        "Efternamn",
        "Personnummer",
        "Vårdnadshavare 1 förnamn",
        "Guardian 3 email",
        "Foresatt 12 mobil",
        "Okänd kolumn",
      ],
      "SE",
    );
    expect(columnMap).toEqual({
      "0": "givenName",
      "1": "familyName",
      "2": "personalIdentityNumber",
      "3": "guardian.1.givenName",
      "4": "guardian.3.email",
      "5": "guardian.12.phone",
    });
  });

  it("recognises the IdrottOnline export in the se pack", () => {
    const result = suggestMapping(
      ["IdrottsID", "Förnamn", "Efternamn", "Födelsedat./Personnr.", "Medlem sedan"],
      "SE",
    );
    expect(result.detectedSource).toBe("idrottonline");
    expect(result.columnMap).toMatchObject({ "3": "personalIdentityNumber", "4": "startDate" });
    expect(suggestMapping(["IdrottsID"], "NO").detectedSource).toBeNull();
  });
});

describe("rows", () => {
  const rules = (options: Partial<RowRules["options"]> = {}): RowRules => ({
    country: "SE",
    dateOrder: "dmy",
    adultAge: 18,
    today: "2026-10-23",
    groups: new Map([["f2015", "group-1"]]),
    options: MemberImportOptionsSchema.parse({ consentNote: "Blankett", ...options }),
    parsePin: () => null,
  });

  it("maps the sample file: a child with four guardians, the minor's email moved", () => {
    const [headers, ...rows] = parseCsv(decodeCsv(readFileSync(SAMPLE)), { maxRows: 100 }) as [
      string[],
      ...string[][],
    ];
    const { columnMap } = suggestMapping(headers, "SE");
    const columns = columnsOf(columnMap);
    const mapped = rows.map((cells) => mapRow(cells, columns, rules()));
    const withFour = mapped.find((m) => m.data.guardians.length === 4);
    expect(withFour?.data.guardians.map((g) => g.kind)).toEqual([
      "parent",
      "parent",
      "step_parent",
      "relative",
    ]);
    expect(mapped.every((m) => !m.issues.includes("name_missing"))).toBe(true);
    const minor = mapped.find((m) => m.issues.includes("minor_email_moved"));
    expect(minor?.data.email).toBeNull();
  });

  it("reports issues as codes", () => {
    const columns = columnsOf({ "0": "fullName", "1": "birthDate", "2": "groups", "3": "email" });
    const row = mapRow(["Ola", "31.02.2015", "F2015, Okänd", "ola@example.com"], columns, rules());
    expect(row.issues).toEqual(
      expect.arrayContaining(["name_missing", "birth_date_invalid", "group_not_found"]),
    );
    const minor = mapRow(["Ola Berg", "2015-01-01", "F2015", "ola@example.com"], columns, rules());
    expect(minor.issues).toEqual(["minor_email_dropped"]);
    expect(minor.data.email).toBeNull();
    expect(minor.data.groupIds).toEqual(["group-1"]);
  });
});

describe("batches and statuses", () => {
  const row = (
    id: number,
    guardians: { given: string; phone: string | null; email?: string }[],
  ) => ({
    id,
    data: {
      guardians: guardians.map((g) => ({
        given: g.given,
        family: "Ek",
        phone: g.phone,
        email: g.email ?? null,
        kind: "parent",
        personId: null,
      })),
    },
  });

  it("keeps rows that share a new guardian in one batch", () => {
    const rows = [
      row(1, [{ given: "Anna", phone: "070-1" }]),
      row(2, [{ given: "Bo", phone: "070-2" }]),
      row(3, [{ given: "Cia", phone: "070-3", email: "cia@example.test" }]),
      row(4, [{ given: "Anna", phone: "070-1" }]),
      row(5, [{ given: "Dan", phone: null, email: "cia@example.test" }]),
    ];
    const batches = importBatches(rows, 2).map((b) => b.map((r) => r.id));
    expect(batches).toEqual([
      [1, 4],
      [2, 3, 5],
    ]);
  });

  it("derives a row's status from its issues and the registrar's choices", () => {
    expect(rowStatus({ issues: ["name_missing"], skippedByUser: false, resolution: null })).toBe(
      "error",
    );
    expect(rowStatus({ issues: ["already_in_club"], skippedByUser: false, resolution: null })).toBe(
      "skipped",
    );
    expect(
      rowStatus({ issues: ["possible_duplicate"], skippedByUser: false, resolution: null }),
    ).toBe("duplicate");
    expect(
      rowStatus({
        issues: ["possible_duplicate"],
        skippedByUser: false,
        resolution: "same_person",
      }),
    ).toBe("new");
    expect(rowStatus({ issues: [], skippedByUser: true, resolution: null })).toBe("skipped");
  });
});
