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
import { createLogger, loadEnvFiles } from "@clubadmin/server-kit";
import {
  accountInvitationToken,
  emailInvitationToken,
  guardianInvitationToken,
} from "@clubadmin/server-kit/invitations";
import {
  FILE_EXPIRY_RULES,
  ObjectStorage,
  objectStorageConfig,
} from "@clubadmin/server-kit/object-storage";
import { relationshipVersionKey, uuidv7 } from "@clubadmin/shared";
import { run, runOnce } from "graphile-worker";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { billingTrialHandler } from "./billing.ts";
import { graphileLogger } from "./graphile-logger.ts";
import { mailHandler, memoryMailProvider } from "./mail.ts";
import { deliverEmails } from "./notifications/deliver.ts";
import { notificationsHandler } from "./notifications/handler.ts";
import { createOutboxHandlers } from "./outbox-handlers.ts";
import { deleteExpiredAttendance } from "./tasks/attendance.ts";
import { readBackupMetrics } from "./tasks/backup-metrics.ts";
import { flagAdultWards, notifyOwnLoginAge } from "./tasks/guardianships.ts";
import { createTaskList } from "./tasks/index.ts";
import { deleteExpiredJoiningData } from "./tasks/joining.ts";
import { expireMemberExports, purgeMemberImports, runMemberExport } from "./tasks/members.ts";

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

const NOTIFICATION_KEY = "worker-test-notification-key-0123456789";

/**
 * Dispatches an event as the worker does (P1.7): invitations by mail.ts,
 * account-bound emails through notifications; then sends every email
 * delivery at once (as if the daily email were due) with `provider`.
 */
async function dispatchMail(
  eventId: string,
  provider: ReturnType<typeof memoryMailProvider>,
  invitationTokenKey: string | undefined,
): Promise<void> {
  const mail = { webUrl: "https://clubadmin.test", invitationTokenKey };
  await outbox.dispatch(t.db, eventId, [
    mailHandler({ provider, ...mail }),
    notificationsHandler({ channels: { email: true, push: false }, mail }),
  ]);
  await t.query(
    "admin",
    "UPDATE notification_deliveries SET digest = false, status = 'queued', send_after = now() WHERE channel = 'email' AND status = 'held'",
  );
  await deliverEmails(
    {
      db: t.db,
      mail: provider,
      push: null,
      tokenKey: NOTIFICATION_KEY,
      webUrl: mail.webUrl,
      mailOptions: mail,
      pushPerHour: 10,
    },
    new Date(Date.now() + 5_000),
  );
}

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
    expect(await flagAdultWards(t.db, { defaultCountry: "SE", today: "2026-06-01" })).toBe(1);
    expect(await flagAdultWards(t.db, { defaultCountry: "SE", today: "2026-06-01" })).toBe(0);

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

  it("uses the country packs of the ward's clubs, the default country without clubs (#6)", async () => {
    const [club, g, w] = [uuidv7(), uuidv7(), uuidv7()];
    const session = await t.connect("admin");
    try {
      await session.query("BEGIN");
      await session.query(
        `INSERT INTO people (id, given_name, family_name, birth_date) VALUES
           ($1, 'G', 'N', '1980-01-01'), ($2, 'W', 'N', '2008-07-01')`,
        [g, w],
      );
      await session.query(
        `INSERT INTO clubs (id, name, slug, country, default_locale, time_zone, currency)
         VALUES ($1, 'Norsk IL', $2, 'NO', 'nb-NO', 'Europe/Oslo', 'NOK')`,
        [club, `norsk-${club.slice(-8)}`],
      );
      await session.query(
        "INSERT INTO club_role_assignments (club_id, person_id, role) VALUES ($1, $2, 'club_manager')",
        [club, g],
      );
      await session.query(
        "INSERT INTO club_memberships (club_id, person_id, status) VALUES ($1, $2, 'active')",
        [club, w],
      );
      await session.query("COMMIT");
    } finally {
      await session.end();
    }
    const { rows } = await t.query<{ g: string }>(
      "admin",
      `INSERT INTO guardianships (guardian_person_id, ward_person_id, kind, rights)
       VALUES ($1, $2, 'parent', '{}') RETURNING id AS g`,
      [g, w],
    );
    const flagged = async () =>
      (
        await t.query<{ flagged: boolean }>(
          "admin",
          "SELECT ward_adult_flagged_at IS NOT NULL AS flagged FROM guardianships WHERE id = $1",
          [rows[0]!.g],
        )
      ).rows[0]?.flagged;
    await flagAdultWards(t.db, { defaultCountry: "SE", today: "2026-06-30" });
    expect(await flagged()).toBe(false);
    await flagAdultWards(t.db, { defaultCountry: "SE", today: "2026-07-01" });
    expect(await flagged()).toBe(true);
  });
});

describe("guardianships: own-login age", () => {
  it("tells each full guardian once when a ward without login reaches the age", async () => {
    const { rows } = await t.query<{ parent: string; relative: string }>(
      "admin",
      `WITH p AS (INSERT INTO people (given_name, family_name, birth_date) VALUES ('P', 'O', '1980-01-01') RETURNING id),
            r AS (INSERT INTO people (given_name, family_name, birth_date) VALUES ('R', 'O', '1950-01-01') RETURNING id),
            w AS (INSERT INTO people (given_name, family_name, birth_date) VALUES ('W', 'O', '2013-03-10') RETURNING id),
            old AS (INSERT INTO people (given_name, family_name, birth_date) VALUES ('Old', 'O', '2000-03-10') RETURNING id),
            gp AS (INSERT INTO guardianships (guardian_person_id, ward_person_id, kind, rights)
                   SELECT p.id, w.id, 'parent', '{}' FROM p, w RETURNING id),
            gr AS (INSERT INTO guardianships (guardian_person_id, ward_person_id, kind, rights)
                   SELECT r.id, w.id, 'relative', '{}' FROM r, w RETURNING id),
            go AS (INSERT INTO guardianships (guardian_person_id, ward_person_id, kind, rights)
                   SELECT p.id, old.id, 'parent', '{}' FROM p, old RETURNING id)
       SELECT (SELECT id FROM gp) AS parent, (SELECT id FROM gr) AS relative`,
    );
    expect(await notifyOwnLoginAge(t.db, { defaultCountry: "SE", today: "2026-03-09" })).toBe(0);
    // The parent only (not the relative, not the long-grown ward).
    expect(await notifyOwnLoginAge(t.db, { defaultCountry: "SE", today: "2026-03-10" })).toBe(1);
    expect(await notifyOwnLoginAge(t.db, { defaultCountry: "SE", today: "2026-03-11" })).toBe(0);
    const { rows: events } = await t.query<{ id: string }>(
      "admin",
      "SELECT payload ->> 'guardianshipId' AS id FROM outbox.events WHERE type = 'guardianship.ward.own_login_age'",
    );
    expect(events.map((e) => e.id)).toEqual([rows[0]!.parent]);
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
      await dispatchMail(eventId, provider, key);
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
    await dispatchMail(decided, provider, key);
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
    await dispatchMail(changed, provider, key);
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

describe("family emails (P1.3)", () => {
  const key = "worker-test-invitation-key-0123456789";

  async function family(options: { protectedWard?: boolean } = {}) {
    const [anna, mikael, child] = [uuidv7(), uuidv7(), uuidv7()];
    const session = await t.connect("admin");
    try {
      await session.query("BEGIN");
      await session.query(
        `INSERT INTO people (id, given_name, family_name, birth_date, protected_identity) VALUES
           ($1, 'Anna', 'Lindqvist', '1984-01-01', false),
           ($2, 'Mikael', 'Lindqvist', '1983-01-01', false),
           ($3, 'Elsa', 'Lindqvist', '2013-03-10', $4)`,
        [anna, mikael, child, options.protectedWard ?? false],
      );
      await session.query(
        `INSERT INTO accounts (person_id, email, email_verified_at, locale) VALUES
           ($1, $3, now(), 'sv'), ($2, $4, now(), 'en')`,
        [
          anna,
          mikael,
          `anna-${anna.slice(-8)}@example.test`,
          `mikael-${mikael.slice(-8)}@example.test`,
        ],
      );
      await session.query("COMMIT");
    } finally {
      await session.end();
    }
    return { anna, mikael, child };
  }

  it("sends the invitation in the inviter's language with the link, never naming a protected ward; resends get the new link", async () => {
    for (const protectedWard of [false, true]) {
      const { anna, child } = await family({ protectedWard });
      const invitationId = uuidv7();
      await t.query(
        "admin",
        `INSERT INTO guardian_invitations (id, ward_person_id, invited_by_person_id, email, token_hash, kind, rights, expires_at)
         VALUES ($1::uuid, $2, $3, 'gunilla@example.test', $1::text, 'relative', '{view_schedule}', now() + interval '14 days')`,
        [invitationId, child, anna],
      );
      const provider = memoryMailProvider();
      const event = await t.db.withSystem("test", {}, (tx) =>
        outbox.publish(tx, "guardianship.invited", { invitationId, wardPersonId: child }),
      );
      await dispatchMail(event, provider, key);
      const [mail] = provider.sent;
      expect(mail!.to).toBe("gunilla@example.test");
      expect(mail!.subject).toBe("Anna Lindqvist bjuder in dig till ClubAdmin");
      expect(mail!.text).toContain("som släkting till");
      expect(mail!.text).toContain(
        `https://clubadmin.test/guardian-invitations/${guardianInvitationToken(key, invitationId, null)}`,
      );
      expect(mail!.text.includes("Elsa")).toBe(!protectedWard);
      expect(mail!.text).toContain("Det här mejlet skickades av ClubAdmin.");

      const resentAt = new Date();
      await t.query("admin", "UPDATE guardian_invitations SET resent_at = $2 WHERE id = $1", [
        invitationId,
        resentAt,
      ]);
      const again = await t.db.withSystem("test", {}, (tx) =>
        outbox.publish(tx, "guardianship.invited", { invitationId, wardPersonId: child }),
      );
      await dispatchMail(again, provider, key);
      expect(provider.sent[1]!.text).toContain(
        guardianInvitationToken(key, invitationId, resentAt),
      );
    }
  });

  it("sends a club's invitation naming the club, never a ward protected in the club (P1.3b)", async () => {
    for (const protectedInClub of [false, true]) {
      const { anna, child } = await family();
      const club = uuidv7();
      const invitationId = uuidv7();
      const session = await t.connect("admin");
      try {
        await session.query("BEGIN");
        await session.query(
          `INSERT INTO clubs (id, name, slug, country, default_locale, time_zone, currency)
           VALUES ($1, 'Bonus IK', $2, 'SE', 'sv-SE', 'Europe/Stockholm', 'SEK')`,
          [club, `bonus-${club.slice(-8)}`],
        );
        await session.query(
          "INSERT INTO club_role_assignments (club_id, person_id, role) VALUES ($1, $2, 'club_manager')",
          [club, anna],
        );
        await session.query(
          `INSERT INTO club_profiles (club_id, person_id, protected_identity_club) VALUES ($1, $2, $3)`,
          [club, child, protectedInClub],
        );
        await session.query(
          `INSERT INTO guardian_invitations (id, ward_person_id, invited_by_person_id, email, token_hash, kind,
             rights, expires_at, club_id, consent_note)
           VALUES ($1::uuid, $2, $3, 'jonas@example.test', $1::text, 'step_parent', '{view_schedule}',
             now() + interval '14 days', $4, 'Blankett')`,
          [invitationId, child, anna, club],
        );
        await session.query("COMMIT");
      } finally {
        await session.end();
      }
      const provider = memoryMailProvider();
      const event = await t.db.withSystem("test", {}, (tx) =>
        outbox.publish(tx, "guardianship.invited", { invitationId, wardPersonId: child }),
      );
      await dispatchMail(event, provider, key);
      const [mail] = provider.sent;
      expect(mail!.subject).toBe("Bonus IK bjuder in dig till ClubAdmin");
      expect(mail!.text).toContain("som bonusförälder");
      expect(mail!.text).toContain(guardianInvitationToken(key, invitationId, null));
      expect(mail!.text.includes("Elsa")).toBe(!protectedInClub);
    }
  });

  it("tells the inviter about the acceptance, the young person about the own login and the guardians about the ages", async () => {
    const { anna, mikael, child } = await family();
    const invitationId = uuidv7();
    const { rows } = await t.query<{ id: string }>(
      "admin",
      `WITH g AS (INSERT INTO guardianships (guardian_person_id, ward_person_id, kind, rights)
                  VALUES ($3, $2, 'parent', '{act_on_behalf}') RETURNING id)
       INSERT INTO guardian_invitations (id, ward_person_id, invited_by_person_id, email, token_hash, kind, rights, expires_at,
         accepted_at, accepted_by_person_id, guardianship_id)
       SELECT $1::uuid, $2, $4, 'mikael@example.test', $1::text, 'parent', '{}', now() + interval '1 day', now(), $3, g.id FROM g
       RETURNING guardianship_id AS id`,
      [invitationId, child, mikael, anna],
    );
    const provider = memoryMailProvider();
    const dispatch = async (
      type: Parameters<typeof outbox.publish>[1],
      payload: Record<string, string>,
    ) => {
      const id = await t.db.withSystem("test", {}, (tx) =>
        outbox.publish(tx, type, payload as never),
      );
      await dispatchMail(id, provider, key);
    };
    await dispatch("guardianship.invitation.accepted", { invitationId, wardPersonId: child });
    expect(provider.sent.at(-1)).toMatchObject({
      subject: "Mikael Lindqvist har tackat ja till din inbjudan",
    });

    const accountInvitation = uuidv7();
    await t.query(
      "admin",
      `INSERT INTO account_invitations (id, person_id, email, token_hash, created_by_person_id, expires_at)
       VALUES ($1::uuid, $2, 'elsa@example.test', $1::text, $3, now() + interval '14 days')`,
      [accountInvitation, child, anna],
    );
    await dispatch("account.invited", { invitationId: accountInvitation, personId: child });
    const own = provider.sent.at(-1)!;
    expect(own).toMatchObject({
      to: "elsa@example.test",
      subject: "Din egen inloggning till ClubAdmin",
    });
    expect(own.text).toContain(
      `https://clubadmin.test/login?invitation=${accountInvitationToken(key, accountInvitation)}`,
    );

    const guardianshipId = rows[0]!.id;
    await dispatch("guardianship.ward.own_login_age", { guardianshipId, wardPersonId: child });
    expect(provider.sent.at(-1)).toMatchObject({
      subject: "Elsa Lindqvist can now get their own login",
    });
    // Adult age without a login of their own: the guardian hears about it.
    await dispatch("guardianship.ward.adult", { guardianshipId, wardPersonId: child });
    expect(provider.sent.at(-1)).toMatchObject({
      subject: "Elsa Lindqvist has reached the adult age",
    });

    await t.query(
      "admin",
      "UPDATE guardianships SET status = 'ended', valid_to = now(), adult_decision = 'ended', adult_decided_at = now() WHERE id = $1",
      [guardianshipId],
    );
    await dispatch("guardianship.adult.ended", { guardianshipId, wardPersonId: child });
    const ended = provider.sent.at(-1)!;
    expect(ended.subject).toBe("Your access as guardian has ended");
    expect(ended.text).toContain("Elsa Lindqvist has reached the adult age and decided");
  });
});

describe("member exports (P1.2)", () => {
  // Garage of the local services (.env.local).
  loadEnvFiles();
  const config = objectStorageConfig({
    S3_ENDPOINT: process.env.S3_ENDPOINT,
    S3_REGION: process.env.S3_REGION ?? "garage",
    S3_BUCKET_FILES: process.env.S3_BUCKET_FILES ?? "clubadmin-files",
    S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
  });
  if (!config) throw new Error("S3_* must be set (pnpm dev:services)");
  const storage = new ObjectStorage(config);
  const fetchFile = async (key: string) =>
    fetch(storage.presignDownload(key, { expiresSeconds: 60, filename: "test.csv" }));

  async function clubWithMembers() {
    const club = uuidv7();
    const [manager, anna, nadia, formula] = [uuidv7(), uuidv7(), uuidv7(), uuidv7()];
    const session = await t.connect("admin");
    try {
      await session.query("BEGIN");
      await session.query(
        `INSERT INTO people (id, given_name, family_name, birth_date, phone, protected_identity) VALUES
           ($1, 'Maja', 'Chef', '1980-01-01', NULL, false),
           ($2, 'Anna', 'Berg', '2017-04-02', '+46 70 111 11 11', false),
           ($3, 'Nadia', 'Skyddad', '2016-01-01', NULL, true),
           ($4, '=HYPERLINK("x")', 'Test', '2001-01-01', NULL, false)`,
        [manager, anna, nadia, formula],
      );
      await session.query(
        `INSERT INTO accounts (person_id, email, email_verified_at, locale) VALUES ($1, $2, now(), 'sv')`,
        [manager, `maja-${manager.slice(-8)}@example.test`],
      );
      await session.query(
        `INSERT INTO clubs (id, name, slug, country, default_locale, time_zone, currency)
         VALUES ($1, 'Export IF', $2, 'SE', 'sv-SE', 'Europe/Stockholm', 'SEK')`,
        [club, `export-${club.slice(-8)}`],
      );
      await session.query(
        `INSERT INTO club_role_assignments (club_id, person_id, role) VALUES ($1, $2, 'club_manager')`,
        [club, manager],
      );
      for (const person of [manager, anna, nadia, formula]) {
        await session.query(
          `INSERT INTO club_memberships (club_id, person_id, status, valid_from)
           VALUES ($1, $2, 'active', '2024-03-01T12:00:00Z')`,
          [club, person],
        );
        await session.query(
          `INSERT INTO club_profiles (club_id, person_id, shared_fields) VALUES ($1, $2, $3)`,
          [club, person, person === anna ? "{phone}" : "{}"],
        );
      }
      await session.query("COMMIT");
    } finally {
      await session.end();
    }
    return { club, manager, anna, nadia };
  }

  const requestExport = (club: string, manager: string, includeProtected: boolean) =>
    t.db.withSystem("test", { clubId: club }, async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`
        INSERT INTO member_exports (club_id, requested_by_person_id, columns, include_protected)
        VALUES (${club}, ${manager}, '{name,memberNumber,phone,joinedOn}', ${includeProtected})
        RETURNING id`);
      return rows[0]!.id;
    });

  it("writes the CSV in the requester's language, without protected members unless chosen", async () => {
    const { club, manager } = await clubWithMembers();
    const exportId = await requestExport(club, manager, false);
    expect(await runMemberExport(t.db, storage, exportId, club)).toBe(3);
    const { rows } = await t.query("admin", "SELECT * FROM member_exports WHERE id = $1", [
      exportId,
    ]);
    expect(rows[0]).toMatchObject({
      status: "ready",
      row_count: 3,
      object_key: `exports/${club}/${exportId}.csv`,
    });
    const res = await fetchFile(rows[0]!.object_key as string);
    expect(res.status).toBe(200);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = bytes.subarray(3).toString("utf8").trimEnd().split("\r\n");
    expect(lines[0]).toBe("Namn,Medlemsnummer,Telefon,Inträde");
    expect(lines).toHaveLength(4);
    expect(lines.some((l) => l.includes("Nadia"))).toBe(false);
    // Phone only where shared; formulas neutralised; ISO dates in the club's time zone.
    expect(lines.find((l) => l.startsWith("Anna Berg"))).toMatch(
      /^Anna Berg,\d+,'\+46 70 111 11 11,2024-03-01$/,
    );
    expect(lines.find((l) => l.includes("HYPERLINK"))).toMatch(/^"'=HYPERLINK\(""x""\) Test",/);

    const marked = await requestExport(club, manager, true);
    expect(await runMemberExport(t.db, storage, marked, club)).toBe(4);
    const text = await (await fetchFile(`exports/${club}/${marked}.csv`)).text();
    expect(text).toContain("Skyddade personuppgifter: dela inte");
    expect(text).toMatch(/Nadia Skyddad,\d+,,2024-03-01,SKYDDAD/);
  });

  it("refuses requesters who lost the role, and deletes files after 24 hours", async () => {
    const { club, manager, anna } = await clubWithMembers();
    const refused = await requestExport(club, anna, false);
    expect(await runMemberExport(t.db, storage, refused, club)).toBeNull();
    const failed = await t.query(
      "admin",
      "SELECT status, error_code FROM member_exports WHERE id = $1",
      [refused],
    );
    expect(failed.rows[0]).toEqual({ status: "failed", error_code: "not_allowed" });

    const exportId = await requestExport(club, manager, false);
    await runMemberExport(t.db, storage, exportId, club);
    await t.query(
      "admin",
      "UPDATE member_exports SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [exportId],
    );
    const result = await expireMemberExports(t.db, storage);
    expect(result.expired).toBeGreaterThanOrEqual(1);
    const { rows } = await t.query(
      "admin",
      "SELECT status, object_key FROM member_exports WHERE id = $1",
      [exportId],
    );
    expect(rows[0]).toEqual({ status: "expired", object_key: null });
    expect((await fetchFile(`exports/${club}/${exportId}.csv`)).status).toBe(404);
  });

  it("sets the bucket's lifecycle rules for exports and imports once", async () => {
    expect(["added", "present"]).toContain(await storage.ensureExpiryRules(FILE_EXPIRY_RULES));
    expect(await storage.ensureExpiryRules(FILE_EXPIRY_RULES)).toBe("present");
  });

  it("emails every club manager about an export", async () => {
    const { club, manager } = await clubWithMembers();
    const exportId = await requestExport(club, manager, true);
    const eventId = await t.db.withSystem("test", { clubId: club }, (tx) =>
      outbox.publish(tx, "members.exported", { exportId, clubId: club }),
    );
    const provider = memoryMailProvider();
    await dispatchMail(eventId, provider, undefined);
    expect(provider.sent).toHaveLength(1);
    const [mail] = provider.sent;
    expect(mail!.subject).toBe("Export IF: medlemsregistret har exporterats");
    expect(mail!.text).toContain("Maja Chef har exporterat medlemsregistret i Export IF");
    expect(mail!.text).toContain("Namn, Medlemsnummer, Telefon och Inträde");
    expect(mail!.text).toContain("skyddade personuppgifter");
    expect(mail!.text).toContain(`https://clubadmin.test/clubs/${club}/members/exports`);
  });

  const insertImport = (club: string, manager: string, status: string, ago: string) =>
    t.db.withSystem("test", { clubId: club }, async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql`
        INSERT INTO member_imports (club_id, created_by_person_id, confirmed_by_person_id, status, options,
          counts, columns, finished_at)
        VALUES (${club}, ${manager}, ${manager}, ${status}, '{}'::jsonb,
          '{"rows":3,"new":0,"duplicate":0,"error":1,"skipped":0,"imported":2,"guardians":1,"invitations":1}'::jsonb,
          '[{"index":0,"header":"Förnamn","sample":"Anna","suggested":"givenName"}]'::jsonb,
          now() - ${ago}::interval)
        RETURNING id`);
      const id = rows[0]!.id;
      await tx.execute(sql`
        INSERT INTO member_import_rows (import_id, club_id, row_number, cells)
        VALUES (${id}, ${club}, 1, 'sealed'), (${id}, ${club}, 2, 'sealed')`);
      return id;
    });

  it("emails every club manager when an import finishes (counts, never rows)", async () => {
    const { club, manager } = await clubWithMembers();
    const importId = await insertImport(club, manager, "done", "1 minute");
    const eventId = await t.db.withSystem("test", { clubId: club }, (tx) =>
      outbox.publish(tx, "members.import.finished", { importId, clubId: club }),
    );
    const provider = memoryMailProvider();
    await dispatchMail(eventId, provider, undefined);
    expect(provider.sent).toHaveLength(1);
    const [mail] = provider.sent;
    expect(mail!.subject).toBe("Export IF: en medlemsimport är klar");
    expect(mail!.text).toContain("Maja Chef har importerat medlemmar till Export IF: 2 tillagda");
    expect(mail!.text).toContain("1 inbjudningar skickade");
    expect(mail!.text).not.toContain("Anna");
  });

  it("deletes an import's staging rows seven days after it ended and keeps its counts", async () => {
    const { club, manager } = await clubWithMembers();
    const old = await insertImport(club, manager, "done", "8 days");
    const recent = await insertImport(club, manager, "done", "1 day");
    const result = await purgeMemberImports(t.db, storage);
    expect(result.purged).toBeGreaterThanOrEqual(1);
    const { rows } = await t.query<{
      id: string;
      rows: number;
      purged: boolean;
      columns: unknown[];
      imported: number;
    }>(
      "admin",
      `SELECT i.id, (SELECT count(*)::int FROM member_import_rows r WHERE r.import_id = i.id) AS rows,
         i.purged_at IS NOT NULL AS purged, i.columns, (i.counts->>'imported')::int AS imported
       FROM member_imports i WHERE i.id = ANY($1::uuid[]) ORDER BY i.id`,
      [[old, recent]],
    );
    expect(rows).toEqual([
      { id: old, rows: 0, purged: true, columns: [], imported: 2 },
      { id: recent, rows: 2, purged: false, columns: expect.any(Array) as unknown, imported: 2 },
    ]);
  });
});

describe("joining:retention", () => {
  it("deletes decided requests and unusable invitations after 12 months, nothing else", async () => {
    const club = uuidv7();
    const person = uuidv7();
    const session = await t.connect("admin");
    try {
      await session.query("BEGIN");
      await session.query(
        "INSERT INTO people (id, given_name, family_name) VALUES ($1, 'R', 'T')",
        [person],
      );
      await session.query(
        `INSERT INTO clubs (id, name, slug, country, default_locale, time_zone, currency)
         VALUES ($1, 'Retention IF', $2, 'SE', 'sv-SE', 'Europe/Stockholm', 'SEK')`,
        [club, `retention-${club.slice(-8)}`],
      );
      await session.query(
        "INSERT INTO club_role_assignments (club_id, person_id, role) VALUES ($1, $2, 'club_manager')",
        [club, person],
      );
      await session.query("COMMIT");
    } finally {
      await session.end();
    }
    const old = "now() - interval '13 months'";
    await t.db.withSystem("test", { clubId: club }, async (tx) => {
      await tx.execute(sql`
        INSERT INTO join_requests (club_id, person_id, requested_by_person_id, status, decided_at)
        VALUES (${club}, ${person}, ${person}, 'rejected', now())`);
      await tx.execute(sql`
        INSERT INTO invitations (club_id, kind, token_hash, expires_at, created_by_person_id)
        VALUES (${club}, 'link', ${`old-${club}`}, now() - interval '1 day', ${person}),
               (${club}, 'link', ${`live-${club}`}, now() + interval '1 day', ${person})`);
    });
    // Backdate as the owner (updated_at is set by a trigger on every change).
    await t.query("admin", `ALTER TABLE join_requests DISABLE TRIGGER set_updated_at`);
    await t.query("admin", `ALTER TABLE invitations DISABLE TRIGGER set_updated_at`);
    try {
      await t.query("admin", `UPDATE join_requests SET updated_at = ${old} WHERE club_id = $1`, [
        club,
      ]);
      await t.query("admin", `UPDATE invitations SET updated_at = ${old} WHERE club_id = $1`, [
        club,
      ]);
    } finally {
      await t.query("admin", `ALTER TABLE join_requests ENABLE TRIGGER set_updated_at`);
      await t.query("admin", `ALTER TABLE invitations ENABLE TRIGGER set_updated_at`);
    }
    await t.query(
      "admin",
      `INSERT INTO guardian_invitations (ward_person_id, invited_by_person_id, email, token_hash, kind, rights, expires_at)
       VALUES ($1, $1, 'old@example.test', $2, 'parent', '{}', now() - interval '13 months'),
              ($1, $1, 'recent@example.test', $3, 'parent', '{}', now() - interval '1 month')`,
      [person, `g-old-${club}`, `g-recent-${club}`],
    );
    await t.query(
      "admin",
      `INSERT INTO account_invitations (person_id, email, token_hash, created_by_person_id, expires_at)
       VALUES ($1, 'own@example.test', $2, $1, now() - interval '13 months')`,
      [person, `a-old-${club}`],
    );
    const deleted = await deleteExpiredJoiningData(t.db);
    expect(deleted).toMatchObject({
      joinRequests: 1,
      invitations: 1,
      guardianInvitations: 1,
      accountInvitations: 1,
    });
    const { rows } = await t.query<{ token_hash: string }>(
      "admin",
      "SELECT token_hash FROM invitations WHERE club_id = $1",
      [club],
    );
    expect(rows).toEqual([{ token_hash: `live-${club}` }]);
  });
});

describe("attendance:retention", () => {
  it("deletes answers and attendance after the club's retention, nothing else", async () => {
    const club = uuidv7();
    const person = uuidv7();
    const [old, recent, longKept] = [uuidv7(), uuidv7(), uuidv7()];
    const otherClub = uuidv7();
    const session = await t.connect("admin");
    try {
      await session.query("BEGIN");
      await session.query(
        "INSERT INTO people (id, given_name, family_name) VALUES ($1, 'R', 'T')",
        [person],
      );
      // The second club keeps everything for 24 months.
      await session.query(
        `INSERT INTO clubs (id, name, slug, country, default_locale, time_zone, currency, attendance_retention_months)
         VALUES ($1, 'Närvaro IF', $2, 'SE', 'sv-SE', 'Europe/Stockholm', 'SEK', 12),
                ($3, 'Långminne IF', $4, 'SE', 'sv-SE', 'Europe/Stockholm', 'SEK', 24)`,
        [club, `attendance-${club.slice(-8)}`, otherClub, `attendance-${otherClub.slice(-8)}`],
      );
      await session.query(
        `INSERT INTO club_role_assignments (club_id, person_id, role)
         VALUES ($1, $3, 'club_manager'), ($2, $3, 'club_manager')`,
        [club, otherClub, person],
      );
      const activity = (id: string, clubId: string, monthsAgo: number) =>
        session.query(
          `INSERT INTO activities (id, club_id, kind, title, starts_at, ends_at, created_by_person_id)
           VALUES ($1, $2, 'training', 'Träning', now() - make_interval(months => $3),
             now() - make_interval(months => $3) + interval '1 hour', $4)`,
          [id, clubId, monthsAgo, person],
        );
      await activity(old, club, 13);
      await activity(recent, club, 11);
      await activity(longKept, otherClub, 13);
      for (const [id, clubId] of [
        [old, club],
        [recent, club],
        [longKept, otherClub],
      ] as const) {
        await session.query(
          `INSERT INTO activity_responses (club_id, activity_id, person_id, status, responded_by_person_id)
           VALUES ($1, $2, $3, 'attending', $3)`,
          [clubId, id, person],
        );
        await session.query(
          `INSERT INTO attendance_records (club_id, activity_id, person_id, status, recorded_by_person_id)
           VALUES ($1, $2, $3, 'present', $3)`,
          [clubId, id, person],
        );
      }
      await session.query("COMMIT");
    } finally {
      await session.end();
    }
    const deleted = await deleteExpiredAttendance(t.db);
    expect(deleted).toMatchObject({ responses: 1, attendance: 1 });
    for (const table of ["activity_responses", "attendance_records"]) {
      const { rows } = await t.query<{ activity_id: string }>(
        "admin",
        `SELECT activity_id FROM ${table} WHERE club_id IN ($1, $2) ORDER BY activity_id`,
        [club, otherClub],
      );
      expect(rows.map((r) => r.activity_id).sort()).toEqual([recent, longKept].sort());
    }
    // The activity itself stays.
    const { rows } = await t.query("admin", "SELECT id FROM activities WHERE id = $1", [old]);
    expect(rows).toHaveLength(1);
  });

  it("is refused outside a system job", async () => {
    const [club = ""] = createTestClubs(1);
    await expect(
      t.db.withTenant(asPerson(uuidv7(), club), (tx) =>
        tx.execute(sql`SELECT * FROM app.purge_expired_attendance()`),
      ),
    ).rejects.toThrow(/system job/);
  });
});

describe("events (P1.6)", () => {
  /** A club with an event in 10 days, a child (no login) with a parent and a relative. */
  async function eventWithFamily(options: { endedDaysAgo?: number } = {}) {
    const [club, event, child, parent, relative] = [
      uuidv7(),
      uuidv7(),
      uuidv7(),
      uuidv7(),
      uuidv7(),
    ];
    const session = await t.connect("admin");
    try {
      await session.query("BEGIN");
      await session.query(
        `INSERT INTO people (id, given_name, family_name) VALUES
           ($1, 'Ebbe', 'Lind'), ($2, 'Karin', 'Lind'), ($3, 'Mormor', 'Lind')`,
        [child, parent, relative],
      );
      await session.query(
        `INSERT INTO accounts (person_id, email, email_verified_at, locale) VALUES
           ($1, $3, now(), 'sv'), ($2, $4, now(), 'sv')`,
        [
          parent,
          relative,
          `karin-${parent.slice(-8)}@example.test`,
          `mormor-${relative.slice(-8)}@example.test`,
        ],
      );
      await session.query(
        `INSERT INTO guardianships (guardian_person_id, ward_person_id, kind, rights) VALUES
           ($1, $3, 'parent', '{act_on_behalf,receive_messages,view_schedule,sign_up,see_medical}'),
           ($2, $3, 'relative', '{view_schedule}')`,
        [parent, relative, child],
      );
      await session.query(
        `INSERT INTO clubs (id, name, slug, country, default_locale, time_zone, currency)
         VALUES ($1, 'Cup IF', $2, 'SE', 'sv-SE', 'Europe/Stockholm', 'SEK')`,
        [club, `cup-${club.slice(-8)}`],
      );
      await session.query(
        `INSERT INTO club_role_assignments (club_id, person_id, role) VALUES ($1, $2, 'club_manager')`,
        [club, parent],
      );
      const ended = options.endedDaysAgo;
      await session.query(
        `INSERT INTO events (id, club_id, title, audience, status, starts_at, ends_at,
           registration_closes_at, created_by_person_id)
         VALUES ($1, $2, 'Höstcupen', 'club', 'published', $3, $4, $3, $5)`,
        [
          event,
          club,
          new Date(Date.now() + (ended === undefined ? 10 : -ended - 1) * 86_400_000).toISOString(),
          new Date(Date.now() + (ended === undefined ? 10.5 : -ended) * 86_400_000).toISOString(),
          parent,
        ],
      );
      await session.query("COMMIT");
    } finally {
      await session.end();
    }
    return { club, event, child, parent, relative };
  }

  it("tells the participant's guardians with receive_messages about an offered place", async () => {
    const { club, event, child, parent } = await eventWithFamily();
    const registration = uuidv7();
    await t.query(
      "admin",
      `INSERT INTO event_registrations (id, club_id, event_id, person_id, registered_by_person_id, status, offer_expires_at)
       VALUES ($1, $2, $3, $4, $5, 'offered', now() + interval '24 hours')`,
      [registration, club, event, child, parent],
    );
    const offered = await t.db.withSystem("test", { clubId: club }, (tx) =>
      outbox.publish(tx, "event.offer.made", {
        clubId: club,
        eventId: event,
        registrationId: registration,
        personId: child,
        kind: "offered",
      }),
    );
    const provider = memoryMailProvider();
    await dispatchMail(offered, provider, undefined);
    expect(provider.sent.map((m) => [m.to.startsWith("karin-"), m.subject])).toEqual([
      [true, "Cup IF: en plats på Höstcupen erbjuds Ebbe Lind"],
    ]);
    expect(provider.sent[0]!.text).toContain(`https://clubadmin.test/events/${event}`);

    // Answered meanwhile: an offer that is no longer open is not sent.
    await t.query(
      "admin",
      "UPDATE event_registrations SET status = 'confirmed', offer_expires_at = NULL WHERE id = $1",
      [registration],
    );
    const late = await t.db.withSystem("test", { clubId: club }, (tx) =>
      outbox.publish(tx, "event.offer.made", {
        clubId: club,
        eventId: event,
        registrationId: registration,
        personId: child,
        kind: "offered",
      }),
    );
    await dispatchMail(late, provider, undefined);
    expect(provider.sent).toHaveLength(1);
  });

  it("deletes sensitive answers 30 days after the event, registrations after the retention", async () => {
    const recent = await eventWithFamily({ endedDaysAgo: 10 });
    const old = await eventWithFamily({ endedDaysAgo: 40 });
    const ancient = await eventWithFamily({ endedDaysAgo: 400 });
    for (const x of [recent, old, ancient]) {
      await t.query(
        "admin",
        `INSERT INTO event_registrations (club_id, event_id, person_id, registered_by_person_id, status, sensitive_answers)
         VALUES ($1, $2, $3, $4, 'confirmed', 'sealed')`,
        [x.club, x.event, x.child, x.parent],
      );
    }
    const deleted = await deleteExpiredAttendance(t.db);
    expect(deleted).toMatchObject({ registrations: 1 });
    expect(deleted.sensitiveAnswers).toBeGreaterThanOrEqual(1);
    const { rows } = await t.query<{ event_id: string; sealed: boolean }>(
      "admin",
      `SELECT event_id, sensitive_answers IS NOT NULL AS sealed FROM event_registrations
       WHERE event_id = ANY ($1::uuid[]) ORDER BY event_id`,
      [[recent.event, old.event, ancient.event]],
    );
    expect(rows).toEqual([
      { event_id: recent.event, sealed: true },
      { event_id: old.event, sealed: false },
    ]);
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
