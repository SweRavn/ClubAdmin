// SPDX-License-Identifier: AGPL-3.0-only
// GET /api/v1/ops/backup-status: platform operators with a second factor see
// the last backups and restore verification, with warnings when too old.

import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import type { BackupStatusResponse } from "@clubadmin/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildPerson } from "../../testing/builders.ts";
import { devToken, TEST_DEV_AUTH_KEY } from "../../testing/oidc.ts";
import { createCoreServices } from "../../testing/services.ts";
import { createTestApp, NO_RATE_LIMITS, type TestApp } from "../../testing/test-app.ts";

let t: TestDatabase;
let app: TestApp;
let operator: string;
let other: string;

beforeAll(async () => {
  t = await createTestDatabase();
  const s = createCoreServices(t.db);
  operator = (await buildPerson(s)).id;
  other = (await buildPerson(s)).id;
  await t.query("admin", "INSERT INTO platform_operators (person_id) VALUES ($1)", [operator]);
  app = await createTestApp(
    {
      NODE_ENV: "development",
      DATABASE_URL: t.url("app"),
      DEV_AUTH: "true",
      DEV_AUTH_KEY: TEST_DEV_AUTH_KEY,
      BACKUP_ENABLED: "true",
      ...NO_RATE_LIMITS,
    },
    [],
  );
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

async function status(personId: string, mfa = true) {
  const token = await devToken(personId, { mfa });
  return app.app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: "GET",
      url: "/api/v1/ops/backup-status",
      headers: { authorization: `Bearer ${token}` },
    });
}

describe("GET /api/v1/ops/backup-status", () => {
  it("is for platform operators with a second factor", async () => {
    expect((await status(other)).statusCode).toBe(403);
    const withoutMfa = await status(operator, false);
    expect(withoutMfa.statusCode).toBe(403);
    expect(withoutMfa.json()).toMatchObject({
      type: expect.stringMatching(/#mfa-required$/) as unknown,
    });
  });

  it("warns when nothing was backed up or verified yet", async () => {
    const res = await status(operator);
    expect(res.statusCode).toBe(200);
    const body = res.json<BackupStatusResponse>();
    expect(body.backupsEnabled).toBe(true);
    expect(body.database.lastSuccessAt).toBeNull();
    expect(body.warnings).toEqual(["database_never_backed_up", "restore_never_verified"]);
    expect(body.thresholds).toEqual({ backupHours: 24, filesHours: 3, verificationDays: 8 });
  });

  it("shows the latest runs and warns about old or failed ones", async () => {
    await t.query(
      "admin",
      `INSERT INTO ops.backup_runs (kind, status, started_at, finished_at, label, size_bytes) VALUES
         ('full', 'succeeded', now() - interval '30 hours', now() - interval '30 hours', '20261020-020000F', 1000),
         ('diff', 'failed', now() - interval '6 hours', now() - interval '6 hours', NULL, NULL),
         ('files', 'succeeded', now() - interval '1 hour', now() - interval '1 hour', NULL, 42)`,
    );
    await t.query(
      "admin",
      `INSERT INTO ops.restore_verifications (status, started_at, finished_at, label, checks, initiated_by)
       VALUES ('passed', now() - interval '2 days', now() - interval '2 days', '20261020-020000F',
               '[{"name":"migrations","status":"passed"}]', 'ci:1')`,
    );
    const body = (await status(operator)).json<BackupStatusResponse>();
    expect(body.database).toMatchObject({
      lastLabel: "20261020-020000F",
      lastRunStatus: "failed",
      sizeBytes: 1000,
    });
    expect(body.files).toMatchObject({ lastRunStatus: "succeeded", sizeBytes: 42 });
    expect(body.verification).toMatchObject({
      lastRunStatus: "passed",
      checks: [{ name: "migrations", status: "passed" }],
    });
    expect(body.warnings).toEqual(["database_backup_stale", "database_backup_failed"]);
  });
});
