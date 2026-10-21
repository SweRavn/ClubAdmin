// SPDX-License-Identifier: AGPL-3.0-only
import { uuidv7 } from "@clubadmin/shared";
import { describe, expect, it } from "vitest";

import { settingsFor } from "./context.ts";
import { HISTORY_EXCLUSIONS, isHistoryExcluded } from "./history-exclusions.ts";
import { compareMigrations, type MigrationFile, readMigrationFiles } from "./migrate.ts";
import { lintMigrations } from "./migration-lint.ts";
import { databaseName, redactUrl, withCredentials, withDatabase } from "./urls.ts";

const file = (name: string, sql: string, checksum = "c"): MigrationFile => ({
  name,
  sql,
  checksum,
});

describe("lintMigrations", () => {
  it("flags unsafe statements unless marked expand-contract", () => {
    const warnings = lintMigrations([
      file(
        "0007_changes",
        [
          "ALTER TABLE groups DROP COLUMN legacy;",
          "ALTER TABLE groups RENAME COLUMN a TO b;",
          "-- expand-contract: column unused since release 1.4",
          "ALTER TABLE groups DROP COLUMN obsolete;",
          "ALTER TABLE groups ALTER COLUMN level TYPE integer;",
          "-- DROP TABLE in a comment is fine",
          "ALTER TABLE groups ADD COLUMN ok text;",
        ].join("\n"),
      ),
    ]);
    expect(warnings.map((w) => w.line)).toEqual([1, 2, 5]);
    expect(warnings[0]?.message).toMatch(/drops a column/);
  });

  it("finds no unsafe statements in the shipped migrations", () => {
    expect(lintMigrations(readMigrationFiles())).toEqual([]);
  });
});

describe("compareMigrations", () => {
  it("reports pending, changed and unknown migrations", () => {
    const status = compareMigrations(
      [file("0000_a", "", "1"), file("0001_b", "", "2"), file("0002_c", "", "3")],
      [
        { name: "0000_a", checksum: "1" },
        { name: "0001_b", checksum: "edited" },
        { name: "9999_from_newer_version", checksum: "x" },
      ],
    );
    expect(status).toEqual({
      pending: ["0002_c"],
      changed: ["0001_b"],
      unknown: ["9999_from_newer_version"],
    });
  });

  it("reads migration files in order with stable checksums", () => {
    const files = readMigrationFiles();
    expect(files[0]?.name).toBe("0000_foundation");
    expect(files[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("settingsFor", () => {
  const personId = uuidv7();
  const clubId = uuidv7();

  it("builds transaction settings", () => {
    expect(
      settingsFor({ actorKind: "person", personId, requestId: "r1", ipHash: "h" }, clubId),
    ).toEqual({
      "app.club_id": clubId,
      "app.person_id": personId,
      "app.on_behalf_of": "",
      "app.request_id": "r1",
      "app.actor_kind": "person",
      "app.ip_hash": "h",
      "app.viewer_privileged": "",
      "app.seed_time": "",
    });
    expect(
      settingsFor({ actorKind: "person", personId }, clubId, { viewerPrivileged: true })[
        "app.viewer_privileged"
      ],
    ).toBe("on");
  });

  it("rejects invalid contexts", () => {
    expect(() => settingsFor({ actorKind: "person" })).toThrow(/requires personId/);
    expect(() => settingsFor({ actorKind: "operator" })).toThrow(/requires personId/);
    expect(() => settingsFor({ actorKind: "anonymous", onBehalfOf: personId })).toThrow(
      /onBehalfOf/,
    );
    expect(() => settingsFor({ actorKind: "person", personId: "x' OR 1=1" })).toThrow(/UUID/);
    expect(() => settingsFor({ actorKind: "anonymous" }, "nope")).toThrow(/UUID/);
  });
});

describe("history exclusions", () => {
  it("match exact names and schema wildcards, each with a reason", () => {
    expect(isHistoryExcluded("graphile_worker._private_jobs")).toBe(true);
    expect(isHistoryExcluded("privacy.deletion_ledger")).toBe(true);
    expect(isHistoryExcluded("public.groups")).toBe(false);
    for (const reason of Object.values(HISTORY_EXCLUSIONS))
      expect(reason.length).toBeGreaterThan(10);
  });
});

describe("urls", () => {
  const url = "postgresql://postgres:p%40ss@127.0.0.1:5432/clubadmin";
  it("switches database and credentials and redacts passwords", () => {
    expect(withDatabase(url, "other")).toBe("postgresql://postgres:p%40ss@127.0.0.1:5432/other");
    expect(withCredentials(url, "clubadmin_app", "s3cr3t/!")).toBe(
      "postgresql://clubadmin_app:s3cr3t%2F!@127.0.0.1:5432/clubadmin",
    );
    expect(databaseName(url)).toBe("clubadmin");
    expect(redactUrl(url)).toBe("postgresql://postgres:***@127.0.0.1:5432/clubadmin");
  });
});
