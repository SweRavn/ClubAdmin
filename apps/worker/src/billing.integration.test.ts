// SPDX-License-Identifier: AGPL-3.0-only
// Billing in the worker (P1.13) against a test database: billing:daily ends
// a trial with the chosen plan and issues the invoice, the invoice is
// rendered as a PDF and emailed as an attachment to the invoice address
// (with the optional link), club managers and treasurers get a notice, and
// billing:retention removes accounting records past seven years.

import { createDatabase, type Database, type LedgerSettings, outbox } from "@clubadmin/db";
import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import { DEMO_SELLER } from "@clubadmin/server-kit";
import { uuidv7 } from "@clubadmin/shared";
import type { JobHelpers } from "graphile-worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  billingSendHandler,
  runBillingDaily,
  runBillingRetention,
  sendInvoiceTask,
} from "./billing.ts";
import { memoryMailProvider } from "./mail.ts";
import { notificationsHandler } from "./notifications/handler.ts";

let t: TestDatabase;
let retention: Database;
const club = uuidv7();
const manager = uuidv7();
const treasurer = uuidv7();
const member = uuidv7();
const settings: LedgerSettings = {
  seller: DEMO_SELLER,
  invoicePrefix: "CA-",
  paymentTermsDays: 30,
  defaultPlan: "free",
};

beforeAll(async () => {
  t = await createTestDatabase();
  retention = createDatabase({ url: t.url("retention"), max: 1 });
  for (const [id, email] of [
    [manager, "manager@example.test"],
    [treasurer, "treasurer@example.test"],
    [member, "member@example.test"],
  ] as const) {
    await t.query(
      "admin",
      "INSERT INTO people (id, given_name, family_name) VALUES ($1, 'B', 'W')",
      [id],
    );
    await t.query(
      "admin",
      "INSERT INTO accounts (person_id, email, email_verified_at) VALUES ($1, $2, now())",
      [id, email],
    );
  }
  const session = await t.connect("admin");
  try {
    await session.query("BEGIN");
    await session.query(
      `INSERT INTO clubs (id, name, slug, country, default_locale, time_zone, currency)
       VALUES ($1, 'Worker IF', 'worker-if', 'SE', 'sv-SE', 'Europe/Stockholm', 'SEK')`,
      [club],
    );
    await session.query(
      `INSERT INTO club_role_assignments (club_id, person_id, role)
       VALUES ($1, $2, 'club_manager'), ($1, $3, 'treasurer')`,
      [club, manager, treasurer],
    );
    await session.query("COMMIT");
  } finally {
    await session.end();
  }
  await t.query(
    "admin",
    `WITH p AS (
       INSERT INTO billing.plans (key, name, kind, currency, price_minor) VALUES
         ('free', 'Free', 'base', 'SEK', 0), ('standard', 'Standard', 'base', 'SEK', 49900)
       RETURNING id, price_minor)
     INSERT INTO billing.plan_prices (plan_id, currency, period, price_minor)
     SELECT id, 'SEK', 'month', price_minor FROM p`,
  );
  await t.query(
    "admin",
    `INSERT INTO billing.accounts (club_id, legal_name, address, invoice_email, reference, invoice_locale)
     VALUES ($1, 'Worker Idrottsförening', $2, 'kassor@worker.invalid', 'Kassören', 'sv')`,
    [
      club,
      JSON.stringify({
        street: "Idrottsvägen 1",
        postalCode: "222 22",
        city: "Lund",
        country: "SE",
      }),
    ],
  );
  await t.query(
    "admin",
    `INSERT INTO billing.subscriptions (club_id, plan_id, status, trial_ends_at,
       scheduled_plan_id, scheduled_add_on_plan_ids, scheduled_billing_period, scheduled_effective_at)
     SELECT $1, p.id, 'trial', '2026-03-10T10:00:00Z', p.id, '{}', 'month', '2026-03-10T10:00:00Z'
     FROM billing.plans p WHERE p.key = 'standard'`,
    [club],
  );
}, 120_000);
afterAll(async () => {
  await retention?.close();
  await t?.drop();
});

const helpers = {
  logger: { info: () => {}, error: () => {} },
  job: { id: "1", key: "k" },
} as unknown as JobHelpers;

const events = async (type: string) =>
  (
    await t.query<{ id: string; payload: { invoiceId?: string } }>(
      "admin",
      "SELECT id, payload FROM outbox.events WHERE type = $1 ORDER BY id",
      [type],
    )
  ).rows;

describe("billing:daily", () => {
  it("ends the trial with the chosen plan and issues the first invoice", async () => {
    const result = await runBillingDaily(t.db, settings, new Date("2026-03-10T12:00:00Z"));
    expect(result).toEqual({ clubs: 1, failed: 0 });
    const issued = await events("billing.invoice.issued");
    expect(issued).toHaveLength(1);
    // Running again finds nothing new to invoice.
    await runBillingDaily(t.db, settings, new Date("2026-03-10T13:00:00Z"));
    expect(await events("billing.invoice.issued")).toHaveLength(1);
  });

  it("emails the invoice as a PDF attachment, with the link when configured", async () => {
    const [issued] = await events("billing.invoice.issued");
    const mail = memoryMailProvider();
    const invoiceId = issued!.payload.invoiceId!;
    await sendInvoiceTask({
      db: t.db,
      storage: null,
      mail,
      webUrl: "https://clubadmin.test",
      emailLink: true,
    })({ clubId: club, invoiceId, purpose: "issued" }, helpers);
    expect(mail.sent).toHaveLength(1);
    const [message] = mail.sent;
    expect(message!.to).toBe("kassor@worker.invalid");
    expect(message!.subject).toMatch(/^Faktura CA-\d{6} från /);
    expect(message!.text).toContain(
      `https://clubadmin.test/clubs/${club}/billing?invoice=${invoiceId}`,
    );
    expect(message!.text).toContain(DEMO_SELLER.bankgiro);
    const [attachment] = message!.attachments ?? [];
    expect(attachment?.contentType).toBe("application/pdf");
    expect(attachment?.content.subarray(0, 5).toString()).toBe("%PDF-");
    // Without the link setting the email has no link.
    const plain = memoryMailProvider();
    await sendInvoiceTask({
      db: t.db,
      storage: null,
      mail: plain,
      webUrl: "https://clubadmin.test",
      emailLink: false,
    })({ clubId: club, invoiceId, purpose: "resend" }, helpers);
    expect(plain.sent[0]!.text).not.toContain("https://clubadmin.test");
    // A reminder for a paid invoice is not sent.
    await t.query(
      "admin",
      "UPDATE billing.invoices SET status = 'paid', paid_at = now() WHERE id = $1",
      [invoiceId],
    );
    const reminder = memoryMailProvider();
    await sendInvoiceTask({
      db: t.db,
      storage: null,
      mail: reminder,
      webUrl: "https://clubadmin.test",
      emailLink: false,
    })({ clubId: club, invoiceId, purpose: "reminder", level: 1 }, helpers);
    expect(reminder.sent).toEqual([]);
  });

  it("enqueues the email job and tells club managers and treasurers, never members", async () => {
    const [issued] = await events("billing.invoice.issued");
    await outbox.dispatch(t.db, issued!.id, [
      billingSendHandler(),
      notificationsHandler({
        channels: { email: true, push: false },
        mail: { webUrl: "https://clubadmin.test", invitationTokenKey: undefined },
      }),
    ]);
    const { rows: jobs } = await t.query<{ task_identifier: string }>(
      "admin",
      "SELECT task_identifier FROM graphile_worker.jobs WHERE task_identifier = 'billing:send_invoice'",
    );
    expect(jobs).toHaveLength(1);
    const { rows } = await t.query<{
      recipient_person_id: string;
      type: string;
      params: { number: string };
    }>(
      "admin",
      "SELECT recipient_person_id, type, params FROM notifications WHERE club_id = $1 ORDER BY recipient_person_id",
      [club],
    );
    expect(rows.map((r) => r.recipient_person_id).sort()).toEqual([manager, treasurer].sort());
    expect(rows[0]!.type).toBe("billing.invoice.issued");
    expect(rows[0]!.params.number).toMatch(/^CA-/);
  });
});

describe("billing:retention", () => {
  it("removes invoices past seven years and keeps the rest", async () => {
    // An old invoice from 2018 (kept through 2025), as the ledger would have issued it.
    await t.query(
      "admin",
      `INSERT INTO billing.invoices (club_id, subscription_id, number, currency, total_minor,
         subtotal_minor, status, period_start, period_end, issued_at, due_at, paid_at)
       SELECT $1, s.id, 'OLD-000001', 'SEK', 100, 100, 'paid', '2018-03-01', '2018-04-01',
         '2018-03-01', '2018-03-31', '2018-03-20'
       FROM billing.subscriptions s WHERE s.club_id = $1`,
      [club],
    );
    const before = await t.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM billing.invoices",
    );
    const result = await runBillingRetention(retention, null, new Date("2026-11-07T00:00:00Z"));
    expect(result.invoices).toBe(1);
    const after = await t.query<{ n: number; old: number }>(
      "admin",
      "SELECT count(*)::int AS n, count(*) FILTER (WHERE number = 'OLD-000001')::int AS old FROM billing.invoices",
    );
    expect(after.rows[0]).toEqual({ n: before.rows[0]!.n - 1, old: 0 });
  });
});
