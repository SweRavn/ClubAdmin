// SPDX-License-Identifier: AGPL-3.0-only
// Card payments in the worker (P1.13 part B) against a test database: a card
// invoice is charged at issue; a decline is recorded and retried on days 1,
// 3 and 7 with notices on the first and the last failure; the dunning stays
// that of invoices; a saved card and a paid pay link arrive as provider
// events, fetched by ID and applied once.

import { type Database, ledger, type LedgerSettings } from "@clubadmin/db";
import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import { DEMO_SELLER } from "@clubadmin/server-kit";
import { fakePaymentProvider, type ProviderEvent } from "@clubadmin/server-kit/payments";
import { uuidv7 } from "@clubadmin/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runBillingDaily, runCardCharge, runProviderEvent } from "./billing.ts";

let t: TestDatabase;
let db: Database;
const manager = uuidv7();
const DAY = 86_400_000;
const settings: LedgerSettings = {
  seller: DEMO_SELLER,
  invoicePrefix: "CA-",
  paymentTermsDays: 30,
  defaultPlan: "free",
};

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
  await t.query("admin", "INSERT INTO people (id, given_name, family_name) VALUES ($1, 'K', 'M')", [
    manager,
  ]);
  await t.query(
    "admin",
    `WITH p AS (
       INSERT INTO billing.plans (key, name, kind, currency, price_minor) VALUES
         ('free', 'Free', 'base', 'SEK', 0), ('standard', 'Standard', 'base', 'SEK', 49900)
       RETURNING id, price_minor)
     INSERT INTO billing.plan_prices (plan_id, currency, period, price_minor)
     SELECT id, 'SEK', 'month', price_minor FROM p`,
  );
}, 120_000);
afterAll(async () => {
  await t?.drop();
});

/** A club paying by a saved card, its period ending at the start of March (Stockholm). */
async function cardClub(): Promise<string> {
  const club = uuidv7();
  const session = await t.connect("admin");
  try {
    await session.query("BEGIN");
    await session.query(
      `INSERT INTO clubs (id, name, slug, country, default_locale, time_zone, currency)
       VALUES ($1, 'Kort IF', $2, 'SE', 'sv-SE', 'Europe/Stockholm', 'SEK')`,
      [club, `kort-${club.slice(-12)}`],
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
    `INSERT INTO billing.accounts (club_id, legal_name, address, invoice_email, payment_method,
       provider, provider_customer_id, provider_payment_method_id, card_brand, card_last4)
     VALUES ($1, 'Kort IF', $2, 'kassor@kort.invalid', 'card', 'fake', 'cus_1', 'pm_1', 'visa', '4242')`,
    [
      club,
      JSON.stringify({ street: "Gatan 1", postalCode: "111 11", city: "Lund", country: "SE" }),
    ],
  );
  await t.query(
    "admin",
    `INSERT INTO billing.subscriptions (club_id, plan_id, status, current_period_start, current_period_end)
     SELECT $1, id, 'active', '2026-01-31T23:00:00Z', '2026-02-28T23:00:00Z' FROM billing.plans WHERE key = 'standard'`,
    [club],
  );
  return club;
}

const invoiceOf = async (club: string) =>
  (
    await t.query<{
      id: string;
      status: string;
      payment_method: string;
      card_attempts: number;
      next_card_attempt_at: Date | null;
      issued_at: Date;
    }>(
      "admin",
      `SELECT id, status, payment_method, card_attempts, next_card_attempt_at, issued_at
       FROM billing.invoices WHERE club_id = $1 AND kind = 'invoice'`,
      [club],
    )
  ).rows[0]!;

describe("billing:charge", () => {
  it("charges a card invoice when it is issued", async () => {
    const club = await cardClub();
    const now = new Date("2026-03-01T04:41:00Z");
    await runBillingDaily(db, settings, now);
    const issued = await invoiceOf(club);
    expect(issued).toMatchObject({ status: "open", payment_method: "card", card_attempts: 0 });
    const provider = fakePaymentProvider({ webhookSecret: "s" });
    expect(await runCardCharge(db, provider, { clubId: club, invoiceId: issued.id }, now)).toBe(
      "charged",
    );
    expect(await invoiceOf(club)).toMatchObject({
      status: "paid",
      card_attempts: 1,
      next_card_attempt_at: null,
    });
    // A second job for the same invoice does nothing.
    expect(await runCardCharge(db, provider, { clubId: club, invoiceId: issued.id }, now)).toBe(
      "skipped",
    );
    expect(provider.charges).toHaveLength(1);
  });

  it("retries a declined card on days 1, 3 and 7 and tells the club on the first and last failure", async () => {
    const club = await cardClub();
    const now = new Date("2026-03-01T04:41:00Z");
    await runBillingDaily(db, settings, now);
    const { id, issued_at } = await invoiceOf(club);
    const provider = fakePaymentProvider({ webhookSecret: "s", decline: new Set([id]) });
    const at = (days: number) => new Date(new Date(issued_at).getTime() + days * DAY + 60_000);
    expect(await runCardCharge(db, provider, { clubId: club, invoiceId: id }, now)).toBe("failed");
    let invoice = await invoiceOf(club);
    expect(invoice.card_attempts).toBe(1);
    expect(new Date(invoice.next_card_attempt_at!).getTime()).toBe(
      new Date(issued_at).getTime() + DAY,
    );
    // Not due yet: nothing happens.
    expect(await runCardCharge(db, provider, { clubId: club, invoiceId: id }, at(0))).toBe(
      "skipped",
    );
    for (const day of [1, 3, 7]) {
      expect(await runCardCharge(db, provider, { clubId: club, invoiceId: id }, at(day))).toBe(
        "failed",
      );
    }
    invoice = await invoiceOf(club);
    expect(invoice).toMatchObject({ status: "open", card_attempts: 4, next_card_attempt_at: null });
    const { rows: events } = await t.query<{ payload: { final: boolean } }>(
      "admin",
      "SELECT payload FROM outbox.events WHERE type = 'billing.card.failed' AND club_id = $1 ORDER BY id",
      [club],
    );
    expect(events.map((e) => e.payload.final)).toEqual([false, true]);
    const { rows: payments } = await t.query<{ status: string; failure_code: string }>(
      "admin",
      "SELECT status, failure_code FROM billing.payments WHERE invoice_id = $1",
      [id],
    );
    expect(payments).toHaveLength(4);
    expect(payments.every((p) => p.status === "failed" && p.failure_code === "card_declined")).toBe(
      true,
    );
    // The dunning is that of invoices: past due only after the due date.
    expect(
      (
        await t.query<{ status: string }>(
          "admin",
          "SELECT status FROM billing.subscriptions WHERE club_id = $1",
          [club],
        )
      ).rows[0]!.status,
    ).toBe("active");
  });

  it("finds due retries across clubs for the daily job", async () => {
    const club = await cardClub();
    await runBillingDaily(db, settings, new Date("2026-03-01T04:41:00Z"));
    const { id } = await invoiceOf(club);
    const due = await db.withSystem("billing:test", {}, (tx) =>
      ledger.dueCardCharges(tx, new Date("2026-03-01T05:00:00Z"), 100),
    );
    expect(due).toContainEqual({ clubId: club, invoiceId: id });
  });
});

describe("billing:provider_event", () => {
  const record = async (eventId: string) =>
    (
      await t.query<{ id: string }>(
        "admin",
        "INSERT INTO billing.provider_events (provider, event_id, type) VALUES ('fake', $1, 'x') RETURNING id",
        [eventId],
      )
    ).rows[0]!.id;

  it("makes a saved card the club's payment method, once", async () => {
    const club = await cardClub();
    await t.query(
      "admin",
      "UPDATE billing.accounts SET payment_method = 'invoice', provider_payment_method_id = NULL WHERE club_id = $1",
      [club],
    );
    const events = new Map<string, ProviderEvent>([
      [
        "evt_card",
        {
          kind: "card_saved",
          clubId: club,
          customerId: "cus_9",
          card: {
            paymentMethodId: "pm_9",
            brand: "mastercard",
            last4: "4444",
            expMonth: 12,
            expYear: 2030,
          },
        },
      ],
    ]);
    const provider = fakePaymentProvider({ webhookSecret: "s", events });
    const row = await record("evt_card");
    expect(await runProviderEvent(db, provider, row, new Date())).toBe("card_saved");
    expect(await runProviderEvent(db, provider, row, new Date())).toBe("skipped");
    const { rows } = await t.query(
      "admin",
      "SELECT payment_method, provider_payment_method_id, card_last4 FROM billing.accounts WHERE club_id = $1",
      [club],
    );
    expect(rows[0]).toEqual({
      payment_method: "card",
      provider_payment_method_id: "pm_9",
      card_last4: "4444",
    });
  });

  it("settles an invoice paid through the pay link, idempotent by the provider's reference", async () => {
    const club = await cardClub();
    await runBillingDaily(db, settings, new Date("2026-03-01T04:41:00Z"));
    const { id } = await invoiceOf(club);
    const { rows } = await t.query<{ total_minor: string }>(
      "admin",
      "SELECT total_minor FROM billing.invoices WHERE id = $1",
      [id],
    );
    const paid: ProviderEvent = {
      kind: "payment_succeeded",
      clubId: club,
      invoiceId: id,
      reference: "pi_link_1",
      amountMinor: Number(rows[0]!.total_minor),
    };
    const provider = fakePaymentProvider({
      webhookSecret: "s",
      events: new Map([
        ["evt_pay_1", paid],
        ["evt_pay_2", paid],
      ]),
    });
    await runProviderEvent(db, provider, await record("evt_pay_1"), new Date());
    await runProviderEvent(db, provider, await record("evt_pay_2"), new Date());
    expect((await invoiceOf(club)).status).toBe("paid");
    const payments = await t.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM billing.payments WHERE invoice_id = $1 AND status = 'succeeded'",
      [id],
    );
    expect(payments.rows[0]!.n).toBe(1);
  });
});
