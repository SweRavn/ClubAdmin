// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { backupFor, parseBackupInfo } from "./backup-info.ts";
import { judgeObjectLock, parseObjectLock, parseVersioning } from "./object-lock.ts";
import { formatChecks, mergeLedgers } from "./verify.ts";

const info = JSON.stringify([
  {
    name: "clubadmin",
    backup: [
      {
        label: "20261022-091516F_20261023-020001D",
        type: "diff",
        timestamp: { start: 1792720801, stop: 1792720810 },
      },
      {
        label: "20261022-091516F",
        type: "full",
        timestamp: { start: 1792660516, stop: 1792660522 },
      },
    ],
  },
]);

describe("backup info", () => {
  it("picks the latest backup, or the latest finished before a point in time", () => {
    const entries = parseBackupInfo(info);
    expect(backupFor(entries)?.label).toBe("20261022-091516F_20261023-020001D");
    expect(backupFor(entries, new Date(1792700000 * 1000))?.label).toBe("20261022-091516F");
    expect(backupFor(entries, new Date(1792660000 * 1000))).toBeNull();
    expect(parseBackupInfo("[]")).toEqual([]);
  });
});

describe("object lock", () => {
  const compliant = `<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled>
    <Rule><DefaultRetention><Mode>COMPLIANCE</Mode><Days>40</Days></DefaultRetention></Rule></ObjectLockConfiguration>`;

  it("parses the configuration and versioning", () => {
    expect(parseObjectLock(compliant)).toEqual({ enabled: true, mode: "COMPLIANCE", days: 40 });
    expect(
      parseObjectLock(
        "<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled><Rule><DefaultRetention><Mode>GOVERNANCE</Mode><Years>1</Years></DefaultRetention></Rule></ObjectLockConfiguration>",
      ),
    ).toEqual({ enabled: true, mode: "GOVERNANCE", days: 365 });
    expect(
      parseVersioning(
        "<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>",
      ),
    ).toBe(true);
    expect(parseVersioning("<VersioningConfiguration/>")).toBe(false);
  });

  it("accepts only compliance mode covering the retention, with versioning", () => {
    expect(judgeObjectLock(parseObjectLock(compliant), true, 35).status).toBe("active");
    expect(judgeObjectLock(parseObjectLock(compliant), true, 60)).toMatchObject({
      status: "insufficient",
      detail: expect.stringContaining("less than the 60 days") as unknown,
    });
    expect(
      judgeObjectLock(parseObjectLock(compliant.replace("COMPLIANCE", "GOVERNANCE")), true, 35)
        .status,
    ).toBe("insufficient");
    expect(judgeObjectLock(parseObjectLock(compliant), false, 35).detail).toContain(
      "versioning is off",
    );
    expect(judgeObjectLock(null, false, 35).status).toBe("inactive");
  });
});

describe("restore verification", () => {
  it("merges ledgers by person, keeping the first entry", () => {
    const merged = mergeLedgers(
      [{ person_id: "b", erased_at: "2026-02-01T00:00:00Z", reason: "export" }],
      [
        { person_id: "a", erased_at: "2026-01-01T00:00:00Z", reason: "production" },
        { person_id: "b", erased_at: "2026-02-01T00:00:00Z", reason: "production" },
      ],
    );
    expect(merged.map((e) => [e.person_id, e.reason])).toEqual([
      ["a", "production"],
      ["b", "export"],
    ]);
  });

  it("formats one line per check", () => {
    expect(
      formatChecks([
        { name: "migrations", status: "passed", detail: "6 applied" },
        { name: "object-lock", status: "warning", detail: "not available" },
      ]),
    ).toBe("✔ migrations   passed: 6 applied\n! object-lock  warning: not available");
  });
});
