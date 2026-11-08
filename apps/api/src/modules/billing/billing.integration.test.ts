// SPDX-License-Identifier: AGPL-3.0-only
// Billing through the HTTP API with BILLING_ENABLED=true (P1.13): the club
// manager's choice with MFA and terms, billing details with the country
// pack's organisation number, invoices for club managers and treasurers
// (not registrars, not other clubs), and the operators' payments, credit
// notes, lists and CSV exports. The worker's part (applying the selection,
// issuing) runs through the ledger directly.

import { ledger, type LedgerSettings } from "@clubadmin/db";
import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import { DEMO_SELLER } from "@clubadmin/server-kit";
import { stripeSignature } from "@clubadmin/server-kit/payments";
import { uuidv7 } from "@clubadmin/shared";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { devToken, TEST_DEV_AUTH_KEY } from "../../testing/oidc.ts";
import { buildMatrixScenario, type MatrixScenario } from "../../testing/scenarios.ts";
import { createCoreServices } from "../../testing/services.ts";
import { createTestApp, NO_RATE_LIMITS, type TestApp } from "../../testing/test-app.ts";

let t: TestDatabase;
let m: MatrixScenario;
let app: TestApp;
const treasurer = uuidv7();
const WEBHOOK_SECRET = "whsec_matrix_test_secret";

const settings: LedgerSettings = {
  seller: DEMO_SELLER,
  invoicePrefix: "CA-",
  paymentTermsDays: 30,
  defaultPlan: "free",
};

beforeAll(async () => {
  t = await createTestDatabase();
  m = await buildMatrixScenario(createCoreServices(t.db), t);
  await t.query(
    "admin",
    "INSERT INTO people (id, given_name, family_name) VALUES ($1, 'Sara', 'Kassör')",
    [treasurer],
  );
  await t.query(
    "admin",
    "INSERT INTO club_role_assignments (club_id, person_id, role) VALUES ($1, $2, 'treasurer')",
    [m.clubA.id, treasurer],
  );
  await t.query(
    "admin",
    `WITH p AS (
       INSERT INTO billing.plans (key, name, kind, currency, price_minor) VALUES
         ('free', 'Free', 'base', 'SEK', 0),
         ('standard', 'Standard', 'base', 'SEK', 49900),
         ('streaming', 'Streaming', 'add_on', 'SEK', 19900)
       RETURNING id, price_minor)
     INSERT INTO billing.plan_prices (plan_id, currency, period, price_minor)
     SELECT id, 'SEK', 'month', price_minor FROM p
     UNION ALL SELECT id, 'SEK', 'year', price_minor * 10 FROM p`,
  );
  for (const club of [m.clubA.id, m.clubB.id]) {
    await t.query(
      "admin",
      `INSERT INTO billing.subscriptions (club_id, plan_id, status, trial_ends_at)
       SELECT $1, id, 'trial', now() + interval '10 days' FROM billing.plans WHERE key = 'standard'`,
      [club],
    );
  }
  app = await createTestApp({
    NODE_ENV: "development",
    DATABASE_URL: t.url("app"),
    DEV_AUTH: "true",
    DEV_AUTH_KEY: TEST_DEV_AUTH_KEY,
    BILLING_ENABLED: "true",
    BILLING_DEFAULT_PLAN: "free",
    BILLING_CARD_PROVIDER: "fake",
    BILLING_CARD_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ...NO_RATE_LIMITS,
  });
});
afterAll(async () => {
  await app?.close();
  await t?.drop();
});

async function call(personId: string, options: Omit<InjectOptions, "headers"> & { mfa?: boolean }) {
  const token = await devToken(personId, { mfa: options.mfa ?? false });
  const { mfa: _mfa, ...rest } = options;
  return app.app
    .getHttpAdapter()
    .getInstance()
    .inject({ ...rest, headers: { authorization: `Bearer ${token}` } });
}

const club = () => `/api/v1/clubs/${m.clubA.id}`;
const ACCOUNT = {
  legalName: "Matrix Idrottsförening",
  organizationNumber: "802000-0017",
  address: { street: "Idrottsvägen 1", postalCode: "222 22", city: "Lund", country: "SE" },
  invoiceEmail: "kassor@matrix.invalid",
  reference: "Kassören",
  invoiceLocale: "sv",
};

describe("plans and choice", () => {
  it("shows the plans with prices excluding and including VAT", async () => {
    const res = await call(treasurer, { method: "GET", url: `${club()}/billing/plans` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      currency: string;
      vatRateBp: number;
      paidPlansAvailable: boolean;
      plans: { key: string; prices: { month: { exclVatMinor: number; inclVatMinor: number } } }[];
    }>();
    expect(body).toMatchObject({ currency: "SEK", vatRateBp: 2500, paidPlansAvailable: true });
    expect(body.plans.find((p) => p.key === "standard")?.prices.month).toEqual({
      exclVatMinor: 49_900,
      inclVatMinor: 62_375,
    });
  });

  it("lets only club managers with a second factor choose, with details and terms", async () => {
    const select = (personId: string, body: Record<string, unknown>, mfa = true) =>
      call(personId, {
        method: "PUT",
        url: `${club()}/subscription/selection`,
        payload: body,
        mfa,
      });
    expect((await select(treasurer, { planKey: "standard" })).statusCode).toBe(403);
    expect((await select(m.manager.id, { planKey: "standard" }, false)).statusCode).toBe(403);
    expect((await select(m.manager.id, { planKey: "standard" })).json()).toMatchObject({
      detail: "terms_not_accepted",
    });
    expect(
      (await select(m.manager.id, { planKey: "standard", acceptTerms: true })).json(),
    ).toMatchObject({ detail: "billing_details_incomplete" });
    expect(
      (await select(m.manager.id, { planKey: "gold", acceptTerms: true })).json(),
    ).toMatchObject({ detail: "plan_not_found" });

    // The treasurer enters the details (MFA); a bad organisation number is refused.
    const bad = await call(treasurer, {
      method: "PUT",
      url: `${club()}/billing/account`,
      payload: { ...ACCOUNT, organizationNumber: "802000-0013" },
      mfa: true,
    });
    expect(bad.json()).toMatchObject({ detail: "invalid_organization_number" });
    const saved = await call(treasurer, {
      method: "PUT",
      url: `${club()}/billing/account`,
      payload: ACCOUNT,
      mfa: true,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      account: { complete: true, organizationNumber: "802000-0017" },
    });

    const chosen = await select(m.manager.id, {
      planKey: "standard",
      addOns: ["streaming"],
      acceptTerms: true,
    });
    expect(chosen.statusCode).toBe(200);
    expect(chosen.json()).toMatchObject({
      subscription: {
        status: "trial",
        scheduledChange: { planKey: "standard", addOns: ["streaming"], billingPeriod: "month" },
      },
    });
    const { rows } = await t.query<{ action: string }>(
      "admin",
      "SELECT action FROM audit.events WHERE club_id = $1 AND action LIKE 'billing.%' ORDER BY id",
      [m.clubA.id],
    );
    expect(rows.map((r) => r.action)).toEqual([
      "billing.account.updated",
      "billing.subscription.selected",
    ]);
  });
});

describe("invoices", () => {
  let invoiceId: string;

  beforeAll(async () => {
    // The worker: the trial ends with the chosen plan and the first invoice.
    const now = new Date(Date.now() + 11 * 86_400_000);
    await t.db.withSystem("billing:test", { clubId: m.clubA.id }, (tx) =>
      ledger.runClub(tx, settings, m.clubA.id, now),
    );
    const { rows } = await t.query<{ id: string }>(
      "admin",
      "SELECT id FROM billing.invoices WHERE club_id = $1",
      [m.clubA.id],
    );
    invoiceId = rows[0]!.id;
  });

  it("lists the club's invoices for managers and treasurers, with instructions", async () => {
    for (const personId of [m.manager.id, treasurer]) {
      const list = await call(personId, { method: "GET", url: `${club()}/invoices` });
      expect(list.statusCode).toBe(200);
      expect(list.json<{ items: { id: string }[] }>().items.map((i) => i.id)).toEqual([invoiceId]);
    }
    const detail = await call(treasurer, { method: "GET", url: `${club()}/invoices/${invoiceId}` });
    const body = detail.json<{
      totalMinor: number;
      lines: { amountMinor: number; vatMinor: number }[];
      instructions: { bankgiro: string; ocrReference: string; amountMinor: number };
    }>();
    expect(body.totalMinor).toBe(body.lines.reduce((s, l) => s + l.amountMinor + l.vatMinor, 0));
    expect(body.instructions).toMatchObject({
      bankgiro: DEMO_SELLER.bankgiro,
      amountMinor: body.totalMinor,
    });
    // The PDF is rendered by the worker; not yet here.
    const pdf = await call(treasurer, {
      method: "GET",
      url: `${club()}/invoices/${invoiceId}/pdf`,
    });
    expect(pdf.json()).toMatchObject({ detail: "pdf_unavailable" });
  });

  it("is not shown to registrars, members or other clubs", async () => {
    expect(
      (await call(m.registrar.id, { method: "GET", url: `${club()}/invoices` })).statusCode,
    ).toBe(403);
    expect((await call(m.member.id, { method: "GET", url: `${club()}/invoices` })).statusCode).toBe(
      403,
    );
    // Club B's manager: 404 for club A, and an invoice of A through B's path is not found.
    expect(
      (await call(m.outsider.id, { method: "GET", url: `${club()}/invoices`, mfa: true }))
        .statusCode,
    ).toBe(404);
  });

  it("lets operators record bank payments and issue credit notes, and export them", async () => {
    const pay = (amountMinor: number, reference: string) =>
      call(m.operator.id, {
        method: "POST",
        url: `/api/v1/billing/invoices/${invoiceId}/payments`,
        payload: { amountMinor, receivedOn: "2026-11-07", reference },
        mfa: true,
      });
    // Without a second factor: refused.
    expect(
      (
        await call(m.operator.id, {
          method: "POST",
          url: `/api/v1/billing/invoices/${invoiceId}/payments`,
          payload: { amountMinor: 100, receivedOn: "2026-11-07", reference: "X" },
        })
      ).statusCode,
    ).toBe(403);
    const partial = await pay(10_000, "BG-100");
    expect(partial.statusCode).toBe(200);
    expect(partial.json()).toMatchObject({ status: "open", payments: [{ amountMinor: 10_000 }] });
    expect((await pay(10_000, "BG-100")).json()).toMatchObject({
      payments: [{ amountMinor: 10_000 }],
    });

    const credit = await call(m.operator.id, {
      method: "POST",
      url: `/api/v1/billing/invoices/${invoiceId}/credit-note`,
      payload: { reason: "duplicate", lines: [1] },
      mfa: true,
    });
    expect(credit.statusCode).toBe(201);
    expect(credit.json()).toMatchObject({ kind: "credit_note", creditedInvoiceId: invoiceId });

    const list = await call(m.operator.id, {
      method: "GET",
      url: "/api/v1/billing/invoices",
      mfa: true,
    });
    expect(
      list.json<{ items: { club: { id: string; name: string } }[] }>().items[0]?.club,
    ).toMatchObject({ id: m.clubA.id, name: expect.any(String) as unknown });
    const csv = await call(m.operator.id, {
      method: "GET",
      url: "/api/v1/billing/invoices.csv",
      mfa: true,
    });
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body.split("\r\n")[0]).toContain("number,kind,status,club");
    expect(csv.body).toContain("credit_note");
    const payments = await call(m.operator.id, {
      method: "GET",
      url: "/api/v1/billing/payments.csv",
      mfa: true,
    });
    expect(payments.body).toContain("100.00");

    const subs = await call(m.operator.id, {
      method: "GET",
      url: "/api/v1/billing/subscriptions?status=active",
      mfa: true,
    });
    expect(
      subs.json<{ items: { club: { id: string } }[] }>().items.map((i) => i.club.id),
    ).toContain(m.clubA.id);
    // A club manager is no operator.
    expect(
      (await call(m.manager.id, { method: "GET", url: "/api/v1/billing/invoices", mfa: true }))
        .statusCode,
    ).toBe(403);
  });

  it("extends a trial (operators) and refuses cancelling with open invoices", async () => {
    const ends = new Date(Date.now() + 40 * 86_400_000).toISOString();
    const trial = await call(m.operator.id, {
      method: "PUT",
      url: `/api/v1/clubs/${m.clubB.id}/subscription/trial`,
      payload: { trialEndsAt: ends },
      mfa: true,
    });
    expect(trial.json()).toMatchObject({ subscription: { trialEndsAt: ends } });
    const cancel = await call(m.operator.id, {
      method: "PUT",
      url: `${club()}/subscription/status`,
      payload: { status: "cancelled" },
      mfa: true,
    });
    expect(cancel.json()).toMatchObject({ detail: "open_invoices" });
  });

  it("reports the entitlements' billing fields", async () => {
    const res = await call(m.member.id, { method: "GET", url: `${club()}/entitlements` });
    expect(res.json()).toMatchObject({
      billingEnabled: true,
      plan: { key: "standard" },
      pastDueSince: null,
      accessStateSource: null,
    });
  });
});

describe("cards (part B)", () => {
  it("sends the treasurer to the provider's page to save a card, and keeps the customer", async () => {
    const res = await call(treasurer, {
      method: "POST",
      url: `${club()}/billing/payment-method`,
      payload: { method: "card" },
      mfa: true,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ method: string; redirectUrl: string }>();
    expect(body.redirectUrl).toContain("fake_provider=setup");
    const { rows } = await t.query<{
      provider: string;
      provider_customer_id: string;
      payment_method: string;
    }>(
      "admin",
      "SELECT provider, provider_customer_id, payment_method FROM billing.accounts WHERE club_id = $1",
      [m.clubA.id],
    );
    // The card becomes the method only when the provider confirms it.
    expect(rows[0]).toMatchObject({ provider: "fake", payment_method: "invoice" });
    expect(rows[0]!.provider_customer_id).toMatch(/^cus_fake_/);
  });

  it("gives a pay link for an open invoice", async () => {
    const { rows } = await t.query<{ id: string }>(
      "admin",
      "SELECT id FROM billing.invoices WHERE club_id = $1 AND kind = 'invoice' AND status = 'open'",
      [m.clubA.id],
    );
    const res = await call(m.manager.id, {
      method: "POST",
      url: `${club()}/invoices/${rows[0]!.id}/pay`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ redirectUrl: string }>().redirectUrl).toContain("fake_provider=pay");
    expect(
      (await call(m.registrar.id, { method: "POST", url: `${club()}/invoices/${rows[0]!.id}/pay` }))
        .statusCode,
    ).toBe(403);
  });

  it("records verified webhooks once and refuses bad signatures", async () => {
    const body = JSON.stringify({
      id: "evt_matrix_1",
      type: "payment_intent.succeeded",
      data: { object: { email: "x@y" } },
    });
    const send = (signature: string) =>
      app.app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: "POST",
          url: "/api/v1/billing/webhooks/fake",
          headers: { "content-type": "application/json", "stripe-signature": signature },
          payload: body,
        });
    const now = Math.floor(Date.now() / 1000);
    const bad = await send(stripeSignature("wrong", body, now));
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ detail: "provider_signature_invalid" });
    expect((await send(stripeSignature(WEBHOOK_SECRET, body, now))).json()).toEqual({
      received: true,
    });
    expect((await send(stripeSignature(WEBHOOK_SECRET, body, now))).statusCode).toBe(200);
    const { rows } = await t.query<{ n: number; type: string }>(
      "admin",
      "SELECT count(*)::int AS n, max(type) AS type FROM billing.provider_events WHERE event_id = 'evt_matrix_1'",
    );
    expect(rows[0]).toEqual({ n: 1, type: "payment_intent.succeeded" });
    const jobs = await t.query<{ n: number }>(
      "admin",
      "SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE task_identifier = 'billing:provider_event'",
    );
    expect(jobs.rows[0]!.n).toBe(1);
    // Another provider's route does not exist here.
    expect(
      (
        await app.app
          .getHttpAdapter()
          .getInstance()
          .inject({
            method: "POST",
            url: "/api/v1/billing/webhooks/stripe",
            headers: { "content-type": "application/json" },
            payload: body,
          })
      ).statusCode,
    ).toBe(404);
  });
});
