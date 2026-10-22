// SPDX-License-Identifier: AGPL-3.0-only
// Needs the local services: pnpm dev:services, then pnpm test:integration.
import { type OutboxHandler, sql } from "@clubadmin/db";
import { outbox } from "@clubadmin/db";
import {
  asPerson,
  createTestClubs,
  createTestDatabase,
  type TestDatabase,
} from "@clubadmin/db/testing";
import { createLogger } from "@clubadmin/server-kit";
import { emailInvitationToken } from "@clubadmin/server-kit/invitations";
import { relationshipVersionKey, uuidv7 } from "@clubadmin/shared";
import { run, runOnce } from "graphile-worker";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { billingTrialHandler } from "./billing.ts";
import { graphileLogger } from "./graphile-logger.ts";
import { mailHandler, memoryMailProvider } from "./mail.ts";
import { createOutboxHandlers } from "./outbox-handlers.ts";
import { readBackupMetrics } from "./tasks/backup-metrics.ts";
import { flagAdultWards } from "./tasks/guardianships.ts";
import { createTaskList } from "./tasks/index.ts";

let t: TestDatabase;
const logger = graphileLogger(
  createLogger({
    service: "test",
    level: process.env.TEST_LOG_LEVEL === "debug" ? "debug" : "silent",
  }),
);

beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t.drop();
});

describe("worker with PostgreSQL (as clubadmin_app)", () => {
  it("dispatches committed outbox events to handlers once", async () => {
    const [club = ""] = createTestClubs(1);
    const personId = uuidv7();
    const received: string[] = [];
    const handler: OutboxHandler = {
      name: "test.collect",
      types: ["membership.changed"],
      handle: (event) => {
        received.push(event.id);
        return Promise.resolve();
      },
    };
    const eventId = await t.db.withTenant(asPerson(personId, club), (tx) =>
      outbox.publish(tx, "membership.changed", { clubId: club, personId }),
    );
    const taskList = createTaskList({
      db: t.db,
      outboxHandlers: [handler],
      historyRetentionMonths: 24,
      historyPartitionsAhead: 3,
    });
    await runOnce({ connectionString: t.url("app"), taskList, logger });

    expect(received).toEqual([eventId]);
    const { rows } = await t.query("admin", "SELECT status FROM outbox.events WHERE id = $1", [
      eventId,
    ]);
    expect(rows[0]).toEqual({ status: "done" });
  });

  it("maintains history partitions as the app role", async () => {
    await t.query("admin", "SELECT graphile_worker.add_job('history:maintain_partitions', '{}')");
    const taskList = createTaskList({
      db: t.db,
      outboxHandlers: [],
      historyRetentionMonths: 24,
      historyPartitionsAhead: 6,
    });
    await runOnce({ connectionString: t.url("app"), taskList, logger });
    const { rows } = await t.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = 'history.record_changes'::regclass",
    );
    expect(rows[0]?.n).toBe(8); // current month + 6 ahead + default
    const done = await t.query("admin", "SELECT count(*)::int AS n FROM graphile_worker.jobs");
    expect(done.rows[0]).toEqual({ n: 0 });
  });

  it("does not let the app role run DDL", async () => {
    await expect(
      t.db.withActor({ actorKind: "anonymous" }, (tx) =>
        tx.execute(sql`CREATE TABLE public.nope (id int)`),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("guardianships:flag_adult_wards", () => {
  it("flags (never ends) guardianships of wards who reached the adult age, once", async () => {
    const { rows } = await t.query<{ adult: string; child: string }>(
      "admin",
      `WITH g AS (INSERT INTO people (given_name, family_name, birth_date) VALUES ('G', 'P', '1980-01-01') RETURNING id),
            a AS (INSERT INTO people (given_name, family_name, birth_date) VALUES ('A', 'P', '2008-06-01') RETURNING id),
            c AS (INSERT INTO people (given_name, family_name, birth_date) VALUES ('C', 'P', '2008-06-02') RETURNING id),
            ga AS (INSERT INTO guardianships (guardian_person_id, ward_person_id, kind, rights)
                   SELECT g.id, a.id, 'parent', '{}' FROM g, a RETURNING id),
            gc AS (INSERT INTO guardianships (guardian_person_id, ward_person_id, kind, rights)
                   SELECT g.id, c.id, 'parent', '{}' FROM g, c RETURNING id)
       SELECT (SELECT id FROM ga) AS adult, (SELECT id FROM gc) AS child`,
    );
    const ids = rows[0]!;
    // On 2026-06-01 the first ward turns 18, the second the day after.
    expect(await flagAdultWards(t.db, "2026-06-01")).toBe(1);
    expect(await flagAdultWards(t.db, "2026-06-01")).toBe(0);

    const { rows: state } = await t.query<{ id: string; status: string; flagged: boolean }>(
      "admin",
      "SELECT id, status, ward_adult_flagged_at IS NOT NULL AS flagged FROM guardianships WHERE id = ANY ($1) ORDER BY id",
      [[ids.adult, ids.child]],
    );
    expect(state).toEqual(
      [
        { id: ids.adult, status: "active", flagged: true },
        { id: ids.child, status: "active", flagged: false },
      ].sort((x, y) => x.id.localeCompare(y.id)),
    );
    const { rows: events } = await t.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM outbox.events WHERE type = 'guardianship.ward.adult' AND payload ->> 'guardianshipId' = $1",
      [ids.adult],
    );
    expect(events[0]?.n).toBe(1);
  });
});

describe("ops:backup_metrics", () => {
  it("reads the last success per kind and whether the latest run failed (as clubadmin_app)", async () => {
    await t.query(
      "admin",
      `INSERT INTO ops.backup_runs (kind, status, started_at, finished_at) VALUES
         ('full', 'succeeded', '2026-10-20T02:00:00Z', '2026-10-20T02:10:00Z'),
         ('diff', 'failed', '2026-10-21T02:00:00Z', '2026-10-21T02:01:00Z'),
         ('monthly', 'failed', '2026-10-01T03:30:00Z', '2026-10-01T03:31:00Z'),
         ('monthly', 'succeeded', '2026-10-02T03:30:00Z', '2026-10-02T03:40:00Z'),
         ('files', 'succeeded', '2026-10-21T03:17:00Z', '2026-10-21T03:18:00Z')`,
    );
    await t.query(
      "admin",
      `INSERT INTO ops.restore_verifications (status, started_at, finished_at, initiated_by)
       VALUES ('passed', '2026-10-19T05:00:00Z', '2026-10-19T05:05:00Z', 'test')`,
    );
    const metrics = await readBackupMetrics(t.db);
    expect(metrics.lastSuccess.get("database")).toBe(Date.parse("2026-10-20T02:10:00Z") / 1000);
    expect(metrics.lastRunFailed.get("database")).toBe(1);
    expect(metrics.lastRunFailed.get("files")).toBe(0);
    // A later success clears the failure.
    expect(metrics.lastRunFailed.get("monthly")).toBe(0);
    expect(metrics.verificationLastSuccess).toBe(Date.parse("2026-10-19T05:05:00Z") / 1000);
    expect(metrics.verificationLastRunFailed).toBe(0);
  });
});

describe("billing trial (club.created, hosted with billing on)", () => {
  it("puts a new club on a trial of the default plan, once", async () => {
    const club = uuidv7();
    const manager = uuidv7();
    const session = await t.connect("admin");
    try {
      await session.query("BEGIN");
      await session.query(
        "INSERT INTO people (id, given_name, family_name) VALUES ($1, 'M', 'G')",
        [manager],
      );
      await session.query(
        `INSERT INTO clubs (id, name, slug, country, default_locale, time_zone, currency)
         VALUES ($1, 'Trial IF', $2, 'SE', 'sv-SE', 'Europe/Stockholm', 'SEK')`,
        [club, `trial-${club.slice(-8)}`],
      );
      await session.query(
        "INSERT INTO club_role_assignments (club_id, person_id, role) VALUES ($1, $2, 'club_manager')",
        [club, manager],
      );
      await session.query("COMMIT");
    } finally {
      await session.end();
    }
    await t.query(
      "admin",
      "INSERT INTO billing.plans (key, name, currency) VALUES ('free', 'Free', 'SEK') ON CONFLICT DO NOTHING",
    );
    const eventId = await t.db.withSystem("test", { clubId: club }, (tx) =>
      outbox.publish(tx, "club.created", { clubId: club }),
    );
    const handler = billingTrialHandler({ defaultPlan: "free", trialDays: 30 });
    await outbox.dispatch(t.db, eventId, [handler]);
    const { rows } = await t.query<{ status: string; days: number }>(
      "admin",
      `SELECT status, round(extract(epoch FROM trial_ends_at - now()) / 86400)::int AS days
       FROM billing.subscriptions WHERE club_id = $1`,
      [club],
    );
    expect(rows).toEqual([{ status: "trial", days: 30 }]);
    // A second event for the same club changes nothing.
    const again = await t.db.withSystem("test", { clubId: club }, (tx) =>
      outbox.publish(tx, "club.created", { clubId: club }),
    );
    await outbox.dispatch(t.db, again, [handler]);
    const count = await t.query(
      "admin",
      "SELECT count(*)::int AS n FROM billing.subscriptions WHERE club_id = $1",
      [club],
    );
    expect(count.rows[0]).toEqual({ n: 1 });
  });
});

describe("transactional email (P1.1)", () => {
  const key = "worker-test-invitation-key-0123456789";

  /** A club with a manager (account, Swedish) and a member (account, English). */
  async function clubWithManager(options: { protectedManager?: boolean } = {}) {
    const club = uuidv7();
    const manager = uuidv7();
    const member = uuidv7();
    const session = await t.connect("admin");
    try {
      await session.query("BEGIN");
      await session.query(
        `INSERT INTO people (id, given_name, family_name, protected_identity) VALUES
           ($1, 'Anna', 'Berg', $3), ($2, 'Nils', 'Ek', false)`,
        [manager, member, options.protectedManager ?? false],
      );
      await session.query(
        `INSERT INTO accounts (person_id, email, email_verified_at, locale) VALUES
           ($1, $3, now(), 'sv'), ($2, $4, now(), 'en')`,
        [
          manager,
          member,
          `anna-${manager.slice(-8)}@example.test`,
          `nils-${member.slice(-8)}@example.test`,
        ],
      );
      await session.query(
        `INSERT INTO clubs (id, name, slug, country, default_locale, time_zone, currency)
         VALUES ($1, 'Mail IF', $2, 'SE', 'sv-SE', 'Europe/Stockholm', 'SEK')`,
        [club, `mail-${club.slice(-8)}`],
      );
      await session.query(
        `INSERT INTO club_role_assignments (club_id, person_id, role) VALUES ($1, $2, 'club_manager')`,
        [club, manager],
      );
      await session.query("COMMIT");
    } finally {
      await session.end();
    }
    return { club, manager, member };
  }

  it("sends an invitation with the derived link; a protected inviter stays unnamed", async () => {
    for (const protectedManager of [false, true]) {
      const { club, manager } = await clubWithManager({ protectedManager });
      const invitationId = uuidv7();
      await t.query(
        "admin",
        `INSERT INTO invitations (id, club_id, kind, email, token_hash, expires_at, created_by_person_id, max_uses)
         VALUES ($1, $2, 'email', 'nora@example.test', $4, now() + interval '14 days', $3, 1)`,
        [invitationId, club, manager, `hash-${invitationId}`],
      );
      const eventId = await t.db.withSystem("test", { clubId: club }, (tx) =>
        outbox.publish(tx, "invitation.created", { invitationId, clubId: club }),
      );
      const provider = memoryMailProvider();
      await outbox.dispatch(t.db, eventId, [
        mailHandler({ provider, webUrl: "https://clubadmin.test", invitationTokenKey: key }),
      ]);
      expect(provider.sent).toHaveLength(1);
      const [mail] = provider.sent;
      expect(mail!.to).toBe("nora@example.test");
      expect(mail!.subject).toBe("Inbjudan till Mail IF");
      expect(mail!.text).toContain(
        `https://clubadmin.test/join/${emailInvitationToken(key, invitationId)}`,
      );
      expect(mail!.text.includes("Anna Berg")).toBe(!protectedManager);
    }
  });

  it("tells the applicant about the decision, and every manager about manager changes", async () => {
    const { club, manager, member } = await clubWithManager();
    const requestId = uuidv7();
    await t.db.withSystem("test", { clubId: club }, (tx) =>
      tx.execute(sql`
        INSERT INTO join_requests (id, club_id, person_id, requested_by_person_id, status, decided_at, decision_message)
        VALUES (${requestId}, ${club}, ${member}, ${member}, 'approved', now(), 'Training on Tuesdays')`),
    );
    const decided = await t.db.withSystem("test", { clubId: club }, (tx) =>
      outbox.publish(tx, "join_request.decided", { joinRequestId: requestId, clubId: club }),
    );
    const provider = memoryMailProvider();
    const handler = mailHandler({
      provider,
      webUrl: "https://clubadmin.test",
      invitationTokenKey: key,
    });
    await outbox.dispatch(t.db, decided, [handler]);
    expect(provider.sent.map((m) => [m.subject, m.text.includes("Training on Tuesdays")])).toEqual([
      ["Mail IF: welcome!", true],
    ]);

    await t.query(
      "admin",
      "INSERT INTO club_role_assignments (club_id, person_id, role) VALUES ($1, $2, 'club_manager')",
      [club, member],
    );
    const changed = await t.db.withSystem("test", { clubId: club }, (tx) =>
      outbox.publish(tx, "club.manager.changed", {
        clubId: club,
        personId: member,
        change: "appointed",
      }),
    );
    await outbox.dispatch(t.db, changed, [handler]);
    const managerMails = provider.sent.slice(1);
    expect(managerMails.map((m) => m.subject).sort()).toEqual([
      "Mail IF: club managers changed",
      "Mail IF: föreningsansvariga har ändrats",
    ]);
    expect(managerMails.every((m) => m.text.includes("Nils Ek"))).toBe(true);
    expect(new Set(managerMails.map((m) => m.messageId)).size).toBe(2);
    void manager;
  });
});

describe("authorization cache invalidation", () => {
  it("bumps the relationship version within a second of a committed role change", async () => {
    const valkey = new Redis(process.env.VALKEY_URL ?? "redis://127.0.0.1:6379");
    const runner = await run({
      connectionString: t.url("app"),
      concurrency: 2,
      noHandleSignals: true,
      pollInterval: 60_000, // LISTEN/NOTIFY must deliver the job, not polling
      logger,
      taskList: createTaskList({
        db: t.db,
        outboxHandlers: createOutboxHandlers({ valkey }),
        historyRetentionMonths: 24,
        historyPartitionsAhead: 3,
      }),
    });
    try {
      const [club = ""] = createTestClubs(1);
      const personId = uuidv7();
      const key = relationshipVersionKey(personId);
      const started = performance.now();
      await t.db.withTenant(asPerson(uuidv7(), club), (tx) =>
        outbox.publish(tx, "role.changed", { clubId: club, personId }),
      );
      let version: string | null = null;
      while (version === null && performance.now() - started < 5_000) {
        version = await valkey.get(key);
        if (version === null) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(version).toBe("1");
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(await valkey.ttl(key)).toBeGreaterThan(0);
    } finally {
      await runner.stop();
      valkey.disconnect();
    }
  });
});
