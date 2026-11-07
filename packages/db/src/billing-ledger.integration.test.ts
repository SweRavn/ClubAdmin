// SPDX-License-Identifier: AGPL-3.0-only
// The billing ledger (P1.13, ADR 0045) against the database: trials,
// selections, periods, invoices with VAT and gapless numbers, credit notes,
// payments, dunning and the access state, with a fixed clock.

import { isValidLuhn, uuidv7 } from "@clubadmin/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ledger, type LedgerSettings } from "./billing.ts";
import type { ActorContext } from "./context.ts";
import { createTestDatabase, type TestDatabase } from "./testing/index.ts";

let t: TestDatabase;
const operator = uuidv7();
const manager = uuidv7();
const plans = { free: uuidv7(), standard: uuidv7(), premium: uuidv7(), streaming: uuidv7() };
const prices: Record<keyof typeof plans, number> = {
  free: 0,
  standard: 49_900,
  premium: 99_900,
  streaming: 19_900,
};

const settings: LedgerSettings = {
  seller: {
    name: "Exempelbolaget ClubAdmin AB (fiktivt)",
    organizationNumber: "559999-9999",
    vatNumber: "SE559999999901",
    address: { street: "Exempelgatan 1", postalCode: "111 11", city: "Stockholm", country: "SE" },
    email: "faktura@clubadmin.invalid",
    bankgiro: "000-0000",
    fTax: true,
    vatRateBp: 2500,
  },
  invoicePrefix: "CA-",
  paymentTermsDays: 30,
  defaultPlan: "free",
};

const asOperator: ActorContext = { actorKind: "operator", personId: operator };
const at = (iso: string) => new Date(iso);
const DAY = 86_400_000;

beforeAll(async () => {
  t = await createTestDatabase();
  for (const id of [operator, manager]) {
    await t.query(
      "admin",
      "INSERT INTO people (id, given_name, family_name) VALUES ($1, 'L', 'P')",
      [id],
    );
  }
  await t.query("admin", "INSERT INTO platform_operators (person_id) VALUES ($1)", [operator]);
  for (const [key, id] of Object.entries(plans) as [keyof typeof plans, string][]) {
    await t.query(
      "admin",
      `INSERT INTO billing.plans (id, key, name, kind, currency, price_minor)
       VALUES ($1, $2, $3, $4, 'SEK', $5)`,
      [
        id,
        key,
        key[0]!.toUpperCase() + key.slice(1),
        key === "streaming" ? "add_on" : "base",
        prices[key],
      ],
    );
    await t.query(
      "admin",
      `INSERT INTO billing.plan_prices (plan_id, currency, period, price_minor)
       VALUES ($1, 'SEK', 'month', $2), ($1, 'SEK', 'year', $2 * 10)`,
      [id, prices[key]],
    );
  }
});
afterAll(async () => {
  await t?.drop();
});

/** A Swedish club with complete billing details and a subscription. */
async function scenario(subscription: {
  plan: keyof typeof plans;
  status: string;
  trialEndsAt?: string;
  periodStart?: string;
  periodEnd?: string;
  addOns?: (keyof typeof plans)[];
  country?: string;
  vatNumber?: string | null;
}): Promise<string> {
  const club = uuidv7();
  const country = subscription.country ?? "SE";
  const session = await t.connect("admin");
  try {
    await session.query("BEGIN");
    await session.query(
      `INSERT INTO clubs (id, name, slug, country, default_locale, time_zone, currency)
       VALUES ($1, 'Ledger IF', $2, $3, 'sv-SE', 'Europe/Stockholm', 'SEK')`,
      [club, `ledger-${club.slice(-12)}`, country],
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
    `INSERT INTO billing.accounts (club_id, legal_name, address, invoice_email, vat_number)
     VALUES ($1, 'Ledger IF', $2, 'kassor@ledger.invalid', $3)`,
    [
      club,
      JSON.stringify({ street: "Idrottsvägen 1", postalCode: "222 22", city: "Lund", country }),
      subscription.vatNumber ?? null,
    ],
  );
  await t.query(
    "admin",
    `INSERT INTO billing.subscriptions (club_id, plan_id, add_on_plan_ids, status, trial_ends_at,
       current_period_start, current_period_end)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      club,
      plans[subscription.plan],
      `{${(subscription.addOns ?? []).map((k) => plans[k]).join(",")}}`,
      subscription.status,
      subscription.trialEndsAt ?? null,
      subscription.periodStart ?? null,
      subscription.periodEnd ?? null,
    ],
  );
  return club;
}

const run = (club: string, now: Date) =>
  t.db.withSystem("billing:test", { clubId: club }, (tx) =>
    ledger.runClub(tx, settings, club, now),
  );

async function sub(club: string) {
  const { rows } = await t.query<{
    plan: string;
    status: string;
    current_period_start: Date | null;
    current_period_end: Date | null;
    past_due_since: Date | null;
    trial_reminder_level: number;
    cancel_at_period_end: boolean;
  }>(
    "admin",
    `SELECT p.key AS plan, s.status, s.current_period_start, s.current_period_end, s.past_due_since,
       s.trial_reminder_level, s.cancel_at_period_end
     FROM billing.subscriptions s JOIN billing.plans p ON p.id = s.plan_id WHERE s.club_id = $1`,
    [club],
  );
  return rows[0]!;
}

async function invoices(club: string) {
  const { rows } = await t.query<{
    id: string;
    number: string | null;
    kind: string;
    status: string;
    subtotal_minor: string;
    vat_minor: string;
    total_minor: string;
    period_start: Date;
    ocr_reference: string | null;
    reminder_level: number;
    lines: { amount: number; vat: number; rate: number; proration: boolean; key: string }[];
  }>(
    "admin",
    `SELECT i.id, i.number, i.kind, i.status, i.subtotal_minor, i.vat_minor, i.total_minor,
       i.period_start, i.ocr_reference, i.reminder_level,
       coalesce((SELECT json_agg(json_build_object('amount', l.amount_minor, 'vat', l.vat_minor,
         'rate', l.vat_rate_bp, 'proration', l.proration, 'key', l.description_key) ORDER BY l.id)
         FROM billing.invoice_lines l WHERE l.invoice_id = i.id), '[]') AS lines
     FROM billing.invoices i WHERE i.club_id = $1 ORDER BY i.id`,
    [club],
  );
  return rows;
}

const selectPlan = (
  club: string,
  plan: keyof typeof plans,
  effectiveAt: string,
  options: { addOns?: (keyof typeof plans)[]; period?: "month" | "year" } = {},
) =>
  t.db.withTenant({ actorKind: "person", personId: manager, clubId: club }, (tx) =>
    tx.execute(sql`
      UPDATE billing.subscriptions
      SET scheduled_plan_id = ${plans[plan]},
        scheduled_add_on_plan_ids = ${`{${(options.addOns ?? []).map((k) => plans[k]).join(",")}}`}::uuid[],
        scheduled_billing_period = ${options.period ?? "month"},
        scheduled_effective_at = ${effectiveAt}::timestamptz, selected_at = now()`),
  );

const outboxOf = async (club: string, type: string) =>
  (
    await t.query<{ payload: Record<string, unknown> }>(
      "admin",
      "SELECT payload FROM outbox.events WHERE club_id = $1 AND type = $2 ORDER BY id",
      [club, type],
    )
  ).rows.map((r) => r.payload);

describe("trials", () => {
  it("reminds 7 days and 1 day before the end, once each", async () => {
    const club = await scenario({
      plan: "standard",
      status: "trial",
      trialEndsAt: "2026-03-10T10:00:00Z",
    });
    await run(club, at("2026-03-01T05:00:00Z")); // 9 days left: nothing
    expect((await sub(club)).trial_reminder_level).toBe(0);
    await run(club, at("2026-03-03T11:00:00Z"));
    await run(club, at("2026-03-04T05:00:00Z"));
    expect((await sub(club)).trial_reminder_level).toBe(1);
    await run(club, at("2026-03-09T11:00:00Z"));
    expect((await sub(club)).trial_reminder_level).toBe(2);
    expect((await outboxOf(club, "billing.subscription.changed")).map((p) => p.change)).toEqual([
      "trial_ending",
      "trial_ending",
    ]);
  });

  it("starts the chosen paid plan at the end with a prorated first invoice", async () => {
    const club = await scenario({
      plan: "standard",
      status: "trial",
      trialEndsAt: "2026-03-10T10:00:00Z",
    });
    await selectPlan(club, "standard", "2026-03-10T10:00:00Z", { addOns: ["streaming"] });
    await run(club, at("2026-03-10T12:00:00Z"));
    const s = await sub(club);
    expect(s).toMatchObject({ plan: "standard", status: "active" });
    expect(s.current_period_end?.toISOString()).toBe("2026-03-31T22:00:00.000Z"); // April 1st in Stockholm
    const [invoice] = await invoices(club);
    // 22 of 31 days of March: 49 900 → 35 413, 19 900 → 14 123; VAT 25 % per line.
    expect(invoice!.lines.map((l) => [l.amount, l.vat, l.rate, l.proration])).toEqual([
      [35_413, 8_853, 2500, true],
      [14_123, 3_531, 2500, true],
    ]);
    expect(Number(invoice!.subtotal_minor)).toBe(35_413 + 14_123);
    expect(Number(invoice!.vat_minor)).toBe(8_853 + 3_531);
    expect(Number(invoice!.total_minor)).toBe(
      Number(invoice!.subtotal_minor) + Number(invoice!.vat_minor),
    );
    expect(invoice!.status).toBe("open");
    expect(invoice!.number).toMatch(/^CA-\d{6}$/);
    expect(isValidLuhn(invoice!.ocr_reference!)).toBe(true);
    expect(await outboxOf(club, "billing.invoice.issued")).toEqual([
      { clubId: club, invoiceId: invoice!.id },
    ]);
  });

  it("moves a club without a choice to the default plan, never to read-only", async () => {
    const club = await scenario({
      plan: "standard",
      status: "trial",
      trialEndsAt: "2026-03-10T10:00:00Z",
    });
    await run(club, at("2026-03-11T04:41:00Z"));
    expect(await sub(club)).toMatchObject({ plan: "free", status: "active" });
    expect(await invoices(club)).toEqual([]);
  });

  it("starts the paid period at once when the manager asks (startNow)", async () => {
    const club = await scenario({
      plan: "standard",
      status: "trial",
      trialEndsAt: "2026-03-30T10:00:00Z",
    });
    await selectPlan(club, "premium", "2026-03-05T09:00:00Z");
    await run(club, at("2026-03-05T09:00:01Z"));
    expect(await sub(club)).toMatchObject({ plan: "premium", status: "active" });
    expect((await invoices(club)).length).toBe(1);
  });
});

describe("periods and changes", () => {
  it("invoices each period once (idempotent)", async () => {
    const club = await scenario({
      plan: "standard",
      status: "active",
      periodStart: "2026-02-28T23:00:00Z",
      periodEnd: "2026-03-31T22:00:00Z",
    });
    await run(club, at("2026-04-01T04:41:00Z"));
    await run(club, at("2026-04-01T05:00:00Z"));
    await run(club, at("2026-04-02T04:41:00Z"));
    const list = await invoices(club);
    expect(list).toHaveLength(1);
    expect(list[0]!.lines.map((l) => [l.amount, l.proration])).toEqual([[49_900, false]]);
    expect((await sub(club)).current_period_end?.toISOString()).toBe("2026-04-30T22:00:00.000Z");
  });

  it("puts an upgrade's difference prorated on the next invoice", async () => {
    const club = await scenario({
      plan: "standard",
      status: "active",
      periodStart: "2026-03-31T22:00:00Z",
      periodEnd: "2026-04-30T22:00:00Z",
    });
    await selectPlan(club, "premium", "2026-04-16T08:00:00Z");
    await run(club, at("2026-04-16T08:00:00Z"));
    expect((await sub(club)).plan).toBe("premium");
    // A draft for May waits with the difference for 15 of 30 days of April.
    const [draft] = await invoices(club);
    expect(draft!.status).toBe("draft");
    expect(draft!.lines).toEqual([
      { amount: 25_000, vat: 0, rate: 0, proration: true, key: "plan.upgrade" },
    ]);
    await run(club, at("2026-05-01T04:41:00Z"));
    const [may] = await invoices(club);
    expect(may!.status).toBe("open");
    expect(may!.lines.map((l) => [l.key, l.amount, l.vat])).toEqual([
      ["plan.upgrade", 25_000, 6_250],
      ["plan.month", 99_900, 24_975],
    ]);
    expect(Number(may!.total_minor)).toBe(25_000 + 6_250 + 99_900 + 24_975);
  });

  it("applies downgrades and cancellations at the period end", async () => {
    const club = await scenario({
      plan: "premium",
      status: "active",
      periodStart: "2026-03-31T22:00:00Z",
      periodEnd: "2026-04-30T22:00:00Z",
    });
    await selectPlan(club, "standard", "2026-04-30T22:00:00Z");
    await run(club, at("2026-04-20T04:41:00Z"));
    expect((await sub(club)).plan).toBe("premium");
    await run(club, at("2026-05-01T04:41:00Z"));
    expect((await sub(club)).plan).toBe("standard");
    expect((await invoices(club))[0]!.lines.map((l) => l.amount)).toEqual([49_900]);

    await t.db.withTenant({ actorKind: "person", personId: manager, clubId: club }, (tx) =>
      tx.execute(sql`UPDATE billing.subscriptions SET cancel_at_period_end = true`),
    );
    await run(club, at("2026-06-01T04:41:00Z"));
    // Back on the free plan (May's invoice is overdue meanwhile: unpaid, not forgiven).
    expect(await sub(club)).toMatchObject({ plan: "free", cancel_at_period_end: false });
    expect(await invoices(club)).toHaveLength(1);
  });

  it("charges no Swedish VAT outside Sweden and reverse charge within the EU", async () => {
    const norway = await scenario({
      plan: "standard",
      status: "active",
      periodStart: "2026-02-28T23:00:00Z",
      periodEnd: "2026-03-31T22:00:00Z",
      country: "NO",
    });
    await run(norway, at("2026-04-01T04:41:00Z"));
    expect((await invoices(norway))[0]!.lines[0]).toMatchObject({ rate: 0, vat: 0 });
    const finland = await scenario({
      plan: "standard",
      status: "active",
      periodStart: "2026-02-28T23:00:00Z",
      periodEnd: "2026-03-31T22:00:00Z",
      country: "FI",
      vatNumber: "FI12345678",
    });
    await run(finland, at("2026-04-01T04:41:00Z"));
    const { rows } = await t.query<{ buyer: { vatNote: string } }>(
      "admin",
      "SELECT buyer FROM billing.invoices WHERE club_id = $1",
      [finland],
    );
    expect(rows[0]!.buyer.vatNote).toBe("reverse_charge");
  });
});

describe("issued invoices", () => {
  it("are immutable, numbered without gaps, and corrected only by credit notes", async () => {
    const club = await scenario({
      plan: "standard",
      status: "active",
      periodStart: "2026-02-28T23:00:00Z",
      periodEnd: "2026-03-31T22:00:00Z",
      addOns: ["streaming"],
    });
    await run(club, at("2026-04-01T04:41:00Z"));
    const [invoice] = await invoices(club);
    await expect(
      t.query("admin", "UPDATE billing.invoices SET total_minor = 1 WHERE id = $1", [invoice!.id]),
    ).rejects.toThrow(/issue a credit note/);
    await expect(
      t.query("admin", "UPDATE billing.invoice_lines SET amount_minor = 1 WHERE invoice_id = $1", [
        invoice!.id,
      ]),
    ).rejects.toThrow(/cannot be changed/);

    // Credit the Streaming line (the second), as an operator.
    const credit = await t.db.withTenant({ ...asOperator, clubId: club }, (tx) =>
      ledger.issueCreditNote(tx, settings, {
        invoiceId: invoice!.id,
        lines: [1],
        reason: "duplicate",
        now: at("2026-04-03T10:00:00Z"),
      }),
    );
    expect(credit.totalMinor).toBe(-(19_900 + 4_975));
    const numbers = (
      await t.query<{ number: string }>(
        "admin",
        "SELECT number FROM billing.invoices WHERE number IS NOT NULL ORDER BY number",
      )
    ).rows.map((r) => Number(r.number.slice(3)));
    expect(numbers).toEqual(numbers.map((_, i) => numbers[0]! + i));
    // Crediting more than is left is refused.
    await expect(
      t.db.withTenant({ ...asOperator, clubId: club }, (tx) =>
        ledger.issueCreditNote(tx, settings, {
          invoiceId: invoice!.id,
          lines: [1],
          reason: "duplicate",
          now: at("2026-04-03T10:00:00Z"),
        }),
      ),
    ).resolves.toBeDefined();
    await expect(
      t.db.withTenant({ ...asOperator, clubId: club }, (tx) =>
        ledger.issueCreditNote(tx, settings, {
          invoiceId: invoice!.id,
          reason: "goodwill",
          now: at("2026-04-03T10:00:00Z"),
        }),
      ),
    ).rejects.toThrow(/credit_exceeds_invoice/);
  });
});

describe("dunning and payments", () => {
  async function overdueClub(): Promise<{ club: string; invoiceId: string; total: number }> {
    const club = await scenario({
      plan: "standard",
      status: "active",
      periodStart: "2026-02-28T23:00:00Z",
      periodEnd: "2026-03-31T22:00:00Z",
    });
    await run(club, at("2026-04-01T04:41:00Z")); // due 2026-05-01T04:41Z
    const [invoice] = await invoices(club);
    return { club, invoiceId: invoice!.id, total: Number(invoice!.total_minor) };
  }

  const access = async (club: string) =>
    (
      await t.query<{ access_state: string; access_state_source: string | null }>(
        "admin",
        "SELECT access_state, access_state_source FROM clubs WHERE id = $1",
        [club],
      )
    ).rows[0]!;

  const pay = (club: string, invoiceId: string, amountMinor: number, reference: string) =>
    t.db.withTenant({ ...asOperator, clubId: club }, (tx) =>
      ledger.recordPayment(tx, {
        invoiceId,
        provider: "manual",
        reference,
        amountMinor,
        receivedOn: "2026-05-31",
        status: "succeeded",
        // Before the next period's invoice (issued 2 May) is overdue.
        now: at("2026-05-31T10:00:00Z"),
      }),
    );

  it("reminds on days 1 and 14, makes the club read-only on day 30, and a payment restores it", async () => {
    const { club, invoiceId, total } = await overdueClub();
    const due = at("2026-05-01T04:41:00Z").getTime();
    await run(club, new Date(due + 1 * DAY + 3600_000));
    expect(await sub(club)).toMatchObject({ status: "past_due" });
    expect((await access(club)).access_state).toBe("active");
    await run(club, new Date(due + 14 * DAY + 3600_000));
    await run(club, new Date(due + 14 * DAY + 7200_000));
    expect((await outboxOf(club, "billing.invoice.overdue")).map((p) => p.level)).toEqual([1, 2]);
    await run(club, new Date(due + 30 * DAY + 3600_000));
    expect(await sub(club)).toMatchObject({ status: "read_only" });
    expect(await access(club)).toEqual({
      access_state: "read_only",
      access_state_source: "billing",
    });

    // A partial payment is recorded but restores nothing; the rest settles it.
    await pay(club, invoiceId, 10_000, "BG-1");
    expect((await sub(club)).status).toBe("read_only");
    await expect(pay(club, invoiceId, total, "BG-2")).rejects.toThrow(/payment_exceeds_balance/);
    // The same reference again changes nothing.
    expect((await pay(club, invoiceId, 10_000, "BG-1")).duplicate).toBe(true);
    const done = await pay(club, invoiceId, total - 10_000, "BG-3");
    expect(done.paid).toBe(true);
    expect(await sub(club)).toMatchObject({ status: "active", past_due_since: null });
    expect(await access(club)).toEqual({ access_state: "active", access_state_source: null });
    expect((await outboxOf(club, "billing.subscription.changed")).map((p) => p.change)).toEqual([
      "renewed",
      "renewed",
      "past_due",
      "read_only",
      "restored",
    ]);
  });

  it("never lifts an operator's restriction on payment", async () => {
    const { club, invoiceId, total } = await overdueClub();
    const due = at("2026-05-01T04:41:00Z").getTime();
    await run(club, new Date(due + 2 * DAY));
    await t.db.withTenant({ ...asOperator, clubId: club }, (tx) =>
      tx.execute(
        sql`UPDATE clubs SET access_state = 'suspended', access_state_source = 'operator'`,
      ),
    );
    await pay(club, invoiceId, total, "BG-OP");
    expect((await sub(club)).status).toBe("active");
    expect(await access(club)).toEqual({
      access_state: "suspended",
      access_state_source: "operator",
    });
  });

  it("finds the clubs with work across clubs (system jobs only)", async () => {
    const { club } = await overdueClub();
    const due = await t.db.withSystem("billing:test", {}, (tx) =>
      ledger.dueClubs(tx, at("2026-05-03T00:00:00Z"), null, 1000),
    );
    expect(due).toContain(club);
    // A club manager sees no other club through it.
    const seen = await t.db.withTenant(
      { actorKind: "person", personId: manager, clubId: club },
      (tx) => ledger.dueClubs(tx, at("2026-05-03T00:00:00Z"), null, 1000),
    );
    expect(seen.every((id) => id === club)).toBe(true);
  });
});
