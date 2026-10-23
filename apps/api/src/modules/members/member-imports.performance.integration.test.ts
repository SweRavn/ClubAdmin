// SPDX-License-Identifier: AGPL-3.0-only
// Import budgets (P1.3b, docs/performance.md): parsing and validating 10,000
// rows under 30 seconds, importing 10,000 members with a guardian each under
// three minutes, through the same code as the import jobs.

import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import { afterAll, beforeAll, expect, it } from "vitest";

import { buildClub, buildPerson } from "../../testing/builders.ts";
import { type CoreServices, createCoreServices } from "../../testing/services.ts";

let t: TestDatabase;
let s: CoreServices;

beforeAll(async () => {
  t = await createTestDatabase();
  s = createCoreServices(t.db);
});
afterAll(async () => {
  await t?.drop();
});

const ROWS = 10_000;

function file(): Buffer {
  const lines = [
    "Förnamn;Efternamn;Födelsedatum;Grupp;Vårdnadshavare 1 namn;Vårdnadshavare 1 mobil",
  ];
  for (let i = 0; i < ROWS; i++) {
    const year = 2008 + (i % 10);
    const day = String(1 + (i % 28)).padStart(2, "0");
    lines.push(
      `Barn${i};Efternamn${Math.floor(i / 2)};${year}-03-${day};Lag;Förälder${Math.floor(i / 2)} Efternamn${Math.floor(i / 2)};070-${String(1_000_000 + Math.floor(i / 2)).slice(1)}`,
    );
  }
  return Buffer.from(lines.join("\n"), "utf8");
}

it("parses 10,000 rows in under 30 s and imports them in under 3 minutes", async () => {
  const club = await buildClub(s);
  const registrar = await buildPerson(s);
  await s.memberships.addMember(club.ctx, registrar.id);
  await s.roles.assignRole(club.ctx, registrar.id, "registrar");
  await s.groups.createGroup(club.ctx, { name: "Lag", kind: "team" });
  const ctx = registrar.as(club.id) as typeof club.ctx;

  let started = Date.now();
  const imported = await s.imports.importFile(ctx, file());
  const parseMs = Date.now() - started;
  expect(imported.counts).toMatchObject({ rows: ROWS, new: ROWS, error: 0 });
  // Siblings (two per family) share one guardian.
  expect(imported.counts.guardians).toBe(ROWS / 2);
  expect(parseMs).toBeLessThan(30_000);

  await s.imports.confirm(ctx, imported.id);
  started = Date.now();
  await s.imports.runJob(imported.id, club.id);
  const runMs = Date.now() - started;
  const done = await s.imports.get(club.ctx, imported.id);
  expect(done.counts).toMatchObject({ imported: ROWS, error: 0 });
  expect(runMs).toBeLessThan(180_000);
}, 300_000);
