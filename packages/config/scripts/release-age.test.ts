// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { releaseAgeExclusions, releaseAgeProblems } from "./release-age.ts";

const workspace = readFileSync(new URL("../../../pnpm-workspace.yaml", import.meta.url), "utf8");
const today = new Date().toISOString().slice(0, 10);

const yaml = (entries: string) => `minimumReleaseAge: 10080
minimumReleaseAgeExclude:
${entries}
overrides:
  foo: 1.0.0
`;

describe("release-age exceptions (critical fixes only)", () => {
  it("pnpm-workspace.yaml follows the rule", () => {
    expect(releaseAgeProblems(workspace, today)).toEqual([]);
  });

  it("accepts an exact version under a critical advisory until its date", () => {
    const text = yaml(`  # GHSA-mrhx-c7xc-m3w5 (critical), until 2026-11-02
  - "@scope/pkg@1.2.4"`);
    expect(releaseAgeExclusions(text)).toEqual([
      { entry: "@scope/pkg@1.2.4", comment: "GHSA-mrhx-c7xc-m3w5 (critical), until 2026-11-02" },
    ]);
    expect(releaseAgeProblems(text, "2026-11-02")).toEqual([]);
  });

  it("refuses ranges, missing advisories, other severities and expired entries", () => {
    expect(releaseAgeProblems(yaml("  - pkg"), "2026-10-25")).toEqual([
      "pkg: name one exact version (name@1.2.3), not a package or a range",
      'pkg: the comment above it must name the advisory and say "critical"',
      'pkg: the comment above it must say "until YYYY-MM-DD"',
    ]);
    expect(
      releaseAgeProblems(
        yaml("  # CVE-2026-12345 (high), until 2026-11-02\n  - pkg@1.0.1"),
        "2026-10-25",
      ),
    ).toEqual(['pkg@1.0.1: the comment above it must name the advisory and say "critical"']);
    expect(
      releaseAgeProblems(
        yaml("  # CVE-2026-12345 (critical), until 2026-11-02\n  - pkg@1.0.1"),
        "2026-11-03",
      ),
    ).toEqual(["pkg@1.0.1: older than seven days since 2026-11-02; remove the exception"]);
    expect(releaseAgeExclusions("minimumReleaseAgeExclude: [a, 'b@1.0.0']")).toEqual([
      { entry: "a", comment: "" },
      { entry: "b@1.0.0", comment: "" },
    ]);
  });
});
