// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  findViolations,
  isExpressionAllowed,
  type LicensePolicy,
  type PackageLicense,
  parsePnpmLicenses,
} from "./licenses.ts";

const policy = JSON.parse(
  readFileSync(new URL("../licenses.json", import.meta.url), "utf8"),
) as LicensePolicy;

const pkg = (name: string, license: string): PackageLicense => ({
  name,
  versions: ["1.0.0"],
  license,
});

describe("isExpressionAllowed", () => {
  const allowed = new Set(["MIT", "Apache-2.0"]);

  it("accepts a single allowed licence", () => {
    expect(isExpressionAllowed("MIT", allowed)).toBe(true);
  });

  it("accepts OR when one side is allowed", () => {
    expect(isExpressionAllowed("(GPL-2.0-only OR MIT)", allowed)).toBe(true);
  });

  it("rejects AND when one side is not allowed", () => {
    expect(isExpressionAllowed("MIT AND GPL-2.0-only", allowed)).toBe(false);
  });

  it("handles nesting and WITH exceptions", () => {
    expect(isExpressionAllowed("(MIT AND (Apache-2.0 OR BSD-3-Clause))", allowed)).toBe(true);
    expect(isExpressionAllowed("Apache-2.0 WITH LLVM-exception", allowed)).toBe(true);
    expect(isExpressionAllowed("GPL-2.0-only WITH Classpath-exception-2.0", allowed)).toBe(false);
  });

  it("throws on malformed expressions", () => {
    expect(() => isExpressionAllowed("(MIT", allowed)).toThrow();
    expect(() => isExpressionAllowed("MIT OR", allowed)).toThrow();
    expect(() => isExpressionAllowed("", allowed)).toThrow();
  });
});

describe("findViolations", () => {
  it("allows GPL-3.0 in the default mode but not in the mobile bundle", () => {
    const packages = [pkg("some-gpl-lib", "GPL-3.0-only"), pkg("react", "MIT")];
    expect(findViolations(packages, policy, "default")).toEqual([]);
    expect(findViolations(packages, policy, "mobile").map((v) => v.name)).toEqual(["some-gpl-lib"]);
  });

  it("rejects LGPL and AGPL in the mobile bundle", () => {
    const packages = [pkg("a", "LGPL-3.0-only"), pkg("b", "AGPL-3.0-only")];
    expect(findViolations(packages, policy, "mobile")).toHaveLength(2);
  });

  it("rejects SSPL and BUSL in both modes", () => {
    const packages = [pkg("some-db", "SSPL-1.0"), pkg("some-tool", "BUSL-1.1")];
    expect(findViolations(packages, policy, "default")).toHaveLength(2);
    expect(findViolations(packages, policy, "mobile")).toHaveLength(2);
  });

  it("rejects missing, unknown and non-SPDX licences", () => {
    const packages = [pkg("a", ""), pkg("b", "Unknown"), pkg("c", "SEE LICENSE IN LICENSE.md")];
    expect(findViolations(packages, policy, "default").map((v) => v.reason)).toEqual([
      "missing or unknown licence",
      "missing or unknown licence",
      "missing or unknown licence",
    ]);
  });

  it("skips ignored workspace packages and listed exceptions", () => {
    const withException: LicensePolicy = {
      ...policy,
      exceptions: { "odd-lib@1.0.0": { reason: "dual licensed, see ADR", adr: "0099" } },
    };
    const packages = [pkg("@clubadmin/api", "AGPL-3.0-only"), pkg("odd-lib", "SSPL-1.0")];
    const ignore = (name: string) => name.startsWith("@clubadmin/");
    expect(findViolations(packages, withException, "mobile", { ignore })).toEqual([]);
  });
});

describe("parsePnpmLicenses", () => {
  it("flattens the licence-grouped pnpm output", () => {
    const output = {
      MIT: [{ name: "react", versions: ["19.0.0"], license: "MIT", paths: [] }],
      "Apache-2.0": [{ name: "typescript", versions: ["6.0.2"], license: "Apache-2.0" }],
    };
    expect(parsePnpmLicenses(output)).toEqual([
      { name: "react", versions: ["19.0.0"], license: "MIT" },
      { name: "typescript", versions: ["6.0.2"], license: "Apache-2.0" },
    ]);
  });
});
