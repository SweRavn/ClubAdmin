// SPDX-License-Identifier: AGPL-3.0-only
// Billing in the worker (BILLING_ENABLED=true only; P0.12, P1.13, ADR 0045):
// a trial for every new club on the hosted service, billing:daily (trial
// reminders and endings, scheduled changes, invoices for periods that have
// started, dunning), a club manager's selection applied at once, the invoice
// PDF and email (billing:send_invoice) and the yearly retention of accounting
// records (billing:retention). The ledger itself is in @clubadmin/db.
// Entitlements caches of the API instances are invalidated through Valkey.

import { createHash } from "node:crypto";

import {
  audit,
  type Database,
  eq,
  inClub,
  ledger,
  LedgerError,
  type LedgerSettings,
  outbox,
  type OutboxHandler,
  sql,
  tables,
  type Tx,
} from "@clubadmin/db";
import { type Locale, localeOf } from "@clubadmin/i18n";
import { billingSeller } from "@clubadmin/server-kit";
import type { ObjectStorage } from "@clubadmin/server-kit/object-storage";
import type { PaymentProvider } from "@clubadmin/server-kit/payments";
import { DOMAIN_EVENTS, ENTITLEMENTS_INVALIDATE_CHANNEL, z } from "@clubadmin/shared";
import type { Task } from "graphile-worker";
import type { Redis } from "ioredis";

import { formatDate, formatMoney, type InvoiceDocument, renderInvoicePdf } from "./billing-pdf.ts";
import { type MailProvider, render } from "./mail.ts";

/** The ledger's settings from the configuration (the demo seller outside production). */
export function billingSettings(
  config: Parameters<typeof billingSeller>[0] & {
    BILLING_INVOICE_PREFIX: string;
    BILLING_PAYMENT_TERMS_DAYS: number;
    BILLING_DEFAULT_PLAN: string;
  },
): LedgerSettings {
  const seller = billingSeller(config);
  if (!seller) throw new Error("BILLING_SELLER_* is not configured");
  return {
    seller,
    invoicePrefix: config.BILLING_INVOICE_PREFIX,
    paymentTermsDays: config.BILLING_PAYMENT_TERMS_DAYS,
    defaultPlan: config.BILLING_DEFAULT_PLAN,
  };
}

/** club.entitlements.changed: drop the club's entitlements on every API instance. */
export function entitlementsCacheHandler(valkey: Redis): OutboxHandler {
  return {
    name: "entitlements-cache",
    types: ["club.entitlements.changed"],
    async handle(event) {
      const { clubId } = DOMAIN_EVENTS["club.entitlements.changed"].parse(event.payload);
      // Publishing twice is harmless: it only forces a reload.
      await valkey.publish(ENTITLEMENTS_INVALIDATE_CHANNEL, clubId);
    },
  };
}

/**
 * club.created on the hosted service: the club starts a trial on
 * BILLING_TRIAL_PLAN (default BILLING_DEFAULT_PLAN) for BILLING_TRIAL_DAYS.
 * Idempotent: a club that already has a subscription keeps it.
 */
export function billingTrialHandler(options: {
  trialPlan: string;
  trialDays: number;
  valkey?: Redis | undefined;
}): OutboxHandler {
  return {
    name: "billing-trial",
    types: ["club.created"],
    async handle(event, tx) {
      const { clubId } = DOMAIN_EVENTS["club.created"].parse(event.payload);
      await tx.execute(sql`SELECT set_config('app.club_id', ${clubId}, true)`);
      const { rows } = await tx.execute<{ id: string }>(sql`
        INSERT INTO billing.subscriptions (club_id, plan_id, status, trial_ends_at, current_period_start, currency)
        SELECT ${clubId}, p.id, 'trial', now() + make_interval(days => ${options.trialDays}), now(), c.currency
        FROM billing.plans p, public.clubs c
        WHERE p.key = ${options.trialPlan} AND p.kind = 'base' AND c.id = ${clubId}
        ON CONFLICT (club_id) DO NOTHING
        RETURNING id`);
      const id = rows[0]?.id;
      if (!id) return;
      await audit.record(tx, {
        action: "billing.subscription.created",
        resourceType: "subscription",
        resourceId: id,
      });
      await options.valkey?.publish(ENTITLEMENTS_INVALIDATE_CHANNEL, clubId);
    },
  };
}

/**
 * A club manager's selection that takes effect now (an upgrade, a paid
 * period started during the trial): applied by the ledger in the same way
 * as billing:daily does, right after the API committed it.
 */
export function billingSelectionHandler(settings: LedgerSettings, now?: () => Date): OutboxHandler {
  return {
    name: "billing-selection",
    types: ["billing.subscription.changed"],
    async handle(event, tx) {
      const { clubId, change } = DOMAIN_EVENTS["billing.subscription.changed"].parse(event.payload);
      if (change !== "selected") return;
      await inClub(tx, clubId, () => ledger.runClub(tx, settings, clubId, now?.() ?? new Date()));
    },
  };
}

const SendPayload = z.object({
  clubId: z.uuid(),
  invoiceId: z.uuid(),
  purpose: z.enum(["issued", "reminder", "resend"]),
  level: z.number().int().min(0).max(2).default(0),
});
type SendPayload = z.infer<typeof SendPayload>;

const enqueueSend = (tx: Tx, payload: SendPayload, key: string) =>
  tx.execute(sql`
    SELECT graphile_worker.add_job('billing:send_invoice', ${JSON.stringify(payload)}::json,
      job_key := ${key}, max_attempts := 10)`);

/** Issued invoices and credit notes, reminders and resends: the PDF by email (a job each). */
export function billingSendHandler(): OutboxHandler {
  return {
    name: "billing-send",
    types: [
      "billing.invoice.issued",
      "billing.invoice.overdue",
      "billing.invoice.resend_requested",
    ],
    async handle(event, tx) {
      switch (event.type) {
        case "billing.invoice.issued": {
          const p = DOMAIN_EVENTS["billing.invoice.issued"].parse(event.payload);
          await enqueueSend(
            tx,
            { ...p, purpose: "issued", level: 0 },
            `billing:send:${p.invoiceId}`,
          );
          // Card invoices are charged at once (the job checks whether one is due).
          await tx.execute(sql`
            SELECT graphile_worker.add_job('billing:charge', ${JSON.stringify(p)}::json,
              job_key := ${`billing:charge:${p.invoiceId}`}, max_attempts := 3)`);
          return;
        }
        case "billing.invoice.overdue": {
          const p = DOMAIN_EVENTS["billing.invoice.overdue"].parse(event.payload);
          const level = Math.min(2, Math.max(1, p.level));
          await enqueueSend(
            tx,
            { clubId: p.clubId, invoiceId: p.invoiceId, purpose: "reminder", level },
            `billing:remind:${p.invoiceId}:${level}`,
          );
          return;
        }
        case "billing.invoice.resend_requested": {
          const p = DOMAIN_EVENTS["billing.invoice.resend_requested"].parse(event.payload);
          await enqueueSend(
            tx,
            { ...p, purpose: "resend", level: 0 },
            `billing:resend:${event.idempotencyKey}`,
          );
          return;
        }
      }
    },
  };
}

/** Clubs per lookup batch of billing:daily (one transaction per club). */
export const DAILY_BATCH = 100;

/** Everything billing has to do today, club by club (idempotent; daily 04:41 UTC). */
export async function runBillingDaily(
  db: Database,
  settings: LedgerSettings,
  now: Date,
  log: { error: (message: string, meta?: Record<string, unknown>) => void } = console,
): Promise<{ clubs: number; failed: number }> {
  let after: string | null = null;
  let clubs = 0;
  let failed = 0;
  for (;;) {
    const ids: string[] = await db.withSystem("billing:daily", {}, (tx) =>
      ledger.dueClubs(tx, now, after, DAILY_BATCH),
    );
    for (const clubId of ids) {
      try {
        await db.withSystem("billing:daily", { clubId }, (tx) =>
          ledger.runClub(tx, settings, clubId, now),
        );
        clubs++;
      } catch (error) {
        // One club's failure never stops the others; the next run retries it.
        failed++;
        log.error("billing: club failed", {
          clubId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (ids.length < DAILY_BATCH) break;
    after = ids.at(-1)!;
  }
  return { clubs, failed };
}

export function billingDailyTask(db: Database, settings: LedgerSettings): Task {
  return async (_payload, helpers) => {
    const now = new Date();
    const result = await runBillingDaily(db, settings, now, helpers.logger);
    const charges = await enqueueDueCharges(db, now);
    helpers.logger.info("billing: daily run", { ...result, charges });
    if (result.failed > 0) throw new Error(`billing: ${result.failed} clubs failed`);
  };
}

// --- The invoice PDF and email --------------------------------------------------------

export interface SendDependencies {
  db: Database;
  storage: ObjectStorage | null;
  mail: MailProvider | null;
  webUrl: string;
  /** BILLING_INVOICE_EMAIL_LINK: the email also links to the invoice page (login required). */
  emailLink: boolean;
}

const pdfKey = (clubId: string, invoiceId: string) => `billing/${clubId}/${invoiceId}.pdf`;

interface InvoiceForSend {
  doc: InvoiceDocument;
  clubName: string;
  invoiceEmail: string | null;
  locale: Locale;
  status: string;
  pdfObjectKey: string | null;
  paymentMethod: string | null;
}

/** The invoice as the PDF shows it, from its snapshots and lines. */
export async function loadInvoiceDocument(
  tx: Tx,
  invoiceId: string,
): Promise<InvoiceForSend | null> {
  const { rows } = await tx.execute<{
    kind: "invoice" | "credit_note";
    number: string | null;
    status: string;
    issued_at: Date | null;
    due_at: Date | null;
    currency: string;
    subtotal_minor: string;
    vat_minor: string;
    total_minor: string;
    ocr_reference: string | null;
    seller: InvoiceDocument["seller"] | null;
    buyer: (InvoiceDocument["buyer"] & { locale?: string }) | null;
    pdf_object_key: string | null;
    payment_method: string | null;
    credited_number: string | null;
    club_name: string;
    time_zone: string;
    invoice_email: string | null;
    invoice_locale: string | null;
  }>(sql`
    SELECT i.kind, i.number, i.status, i.payment_method, i.issued_at, i.due_at, i.currency, i.subtotal_minor,
      i.vat_minor, i.total_minor, i.ocr_reference, i.seller, i.buyer, i.pdf_object_key,
      ci.number AS credited_number, c.name AS club_name, c.time_zone,
      a.invoice_email, a.invoice_locale
    FROM billing.invoices i
    JOIN public.clubs c ON c.id = i.club_id
    LEFT JOIN billing.invoices ci ON ci.id = i.credited_invoice_id
    LEFT JOIN billing.accounts a ON a.club_id = i.club_id
    WHERE i.id = ${invoiceId}`);
  const row = rows[0];
  if (!row?.number || !row.issued_at || !row.seller || !row.buyer) return null;
  const locale: Locale = localeOf(row.buyer.locale ?? row.invoice_locale ?? "sv") ?? "sv";
  const { rows: lines } = await tx.execute<{
    description_key: string;
    plan_name: string | null;
    period_start: Date | null;
    period_end: Date | null;
    proration: boolean;
    quantity: number;
    amount_minor: string;
    vat_rate_bp: number;
    vat_minor: string;
  }>(sql`
    SELECT l.description_key, p.name AS plan_name, l.period_start, l.period_end, l.proration,
      l.quantity, l.amount_minor, l.vat_rate_bp, l.vat_minor
    FROM billing.invoice_lines l LEFT JOIN billing.plans p ON p.id = l.plan_id
    WHERE l.invoice_id = ${invoiceId} ORDER BY l.id`);
  const byRate = new Map<number, { baseMinor: number; vatMinor: number }>();
  for (const l of lines) {
    const r = byRate.get(l.vat_rate_bp) ?? { baseMinor: 0, vatMinor: 0 };
    r.baseMinor += Number(l.amount_minor);
    r.vatMinor += Number(l.vat_minor);
    byRate.set(l.vat_rate_bp, r);
  }
  return {
    clubName: row.club_name,
    invoiceEmail: row.invoice_email,
    locale,
    status: row.status,
    pdfObjectKey: row.pdf_object_key,
    paymentMethod: row.payment_method,
    doc: {
      kind: row.kind,
      number: row.number,
      issuedAt: new Date(row.issued_at),
      dueAt: row.due_at ? new Date(row.due_at) : null,
      currency: row.currency,
      subtotalMinor: Number(row.subtotal_minor),
      vatMinor: Number(row.vat_minor),
      totalMinor: Number(row.total_minor),
      ocrReference: row.ocr_reference,
      creditedNumber: row.credited_number,
      seller: row.seller,
      buyer: row.buyer,
      timeZone: row.time_zone,
      vatByRate: [...byRate.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([rateBp, r]) => ({ rateBp, ...r })),
      lines: lines.map((l) => ({
        description: render(
          locale,
          l.description_key.replaceAll(".", "_"),
          { plan: l.plan_name ?? "" },
          "billing.pdf.lines.",
        ),
        periodStart: l.period_start ? new Date(l.period_start) : null,
        periodEnd: l.period_end ? new Date(l.period_end) : null,
        proration: l.proration,
        quantity: l.quantity,
        amountMinor: Number(l.amount_minor),
        vatRateBp: l.vat_rate_bp,
      })),
    },
  };
}

/** The PDF bytes: stored ones when the bucket has them, else rendered and stored. */
async function invoicePdf(
  tx: Tx,
  deps: SendDependencies,
  clubId: string,
  invoiceId: string,
  invoice: InvoiceForSend,
): Promise<Buffer> {
  if (invoice.pdfObjectKey && deps.storage) {
    const stored = await deps.storage.getObject(invoice.pdfObjectKey, { maxBytes: 5_000_000 });
    if (stored) return stored;
  }
  const pdf = await renderInvoicePdf(invoice.doc, invoice.locale);
  if (deps.storage) {
    const key = pdfKey(clubId, invoiceId);
    await deps.storage.putObject(key, pdf, "application/pdf");
    await tx.execute(sql`
      UPDATE billing.invoices
      SET pdf_object_key = ${key}, pdf_sha256 = ${createHash("sha256").update(pdf).digest("hex")}
      WHERE id = ${invoiceId}`);
  }
  return pdf;
}

/**
 * billing:send_invoice: renders and stores the PDF (once) and emails it as an
 * attachment to the club's invoice address, with a link to the billing page
 * when BILLING_INVOICE_EMAIL_LINK is on. A reminder is only sent while the
 * invoice is still open.
 */
export function sendInvoiceTask(deps: SendDependencies): Task {
  return async (payload, helpers) => {
    const p = SendPayload.parse(payload);
    await deps.db.withSystem("billing:send_invoice", { clubId: p.clubId }, async (tx) => {
      const invoice = await loadInvoiceDocument(tx, p.invoiceId);
      if (!invoice) return;
      if (p.purpose === "reminder" && invoice.status !== "open") return;
      const pdf = await invoicePdf(tx, deps, p.clubId, p.invoiceId, invoice);
      if (!deps.mail || !invoice.invoiceEmail) {
        helpers.logger.info("billing: invoice not emailed (no SMTP or no invoice address)", {
          invoiceId: p.invoiceId,
        });
        return;
      }
      const { doc, locale } = invoice;
      const kind =
        doc.kind === "credit_note"
          ? "creditNote"
          : p.purpose === "reminder"
            ? "reminder"
            : "invoice";
      const link = new URL(
        `/clubs/${p.clubId}/billing?invoice=${p.invoiceId}`,
        deps.webUrl,
      ).toString();
      const readOnlyOn = doc.dueAt ? new Date(doc.dueAt.getTime() + 30 * 86_400_000) : null;
      const values = {
        club: invoice.clubName,
        seller: doc.seller.name,
        number: doc.number,
        credited: doc.creditedNumber ?? "",
        amount: formatMoney(locale, doc.totalMinor, doc.currency),
        due: doc.dueAt ? formatDate(locale, doc.dueAt, doc.timeZone) : "",
        readOnlyOn: readOnlyOn ? formatDate(locale, readOnlyOn, doc.timeZone) : "",
        level: String(p.level),
        bankgiro: doc.seller.bankgiro,
        ocr: doc.ocrReference ?? "",
        method: invoice.paymentMethod === "card" ? "card" : "invoice",
        url: link,
        hasLink: deps.emailLink ? "yes" : "no",
      };
      const filename = `${doc.number}.pdf`;
      await deps.mail.send({
        to: invoice.invoiceEmail,
        subject: render(locale, `billing.${kind}.subject`, values),
        text: `${render(locale, `billing.${kind}.body`, values)}\n\n-- \n${render(locale, "billing.footer", values)}\n`,
        messageId: `billing.${p.invoiceId}.${p.purpose}${p.level}.${helpers.job.key ?? helpers.job.id}`,
        attachments: [{ filename, contentType: "application/pdf", content: pdf }],
      });
    });
  };
}

// --- Retention ------------------------------------------------------------------------

/**
 * billing:retention (yearly, accounting records: 7 years after the end of the
 * calendar year of the invoice; Bokföringslagen): deletes older invoices,
 * credit notes, their lines and payments with their PDFs, and clears the
 * contact fields of billing accounts with nothing left to keep. Runs as the
 * retention role, which sees every club.
 */
export async function runBillingRetention(
  retentionDb: Database,
  storage: ObjectStorage | null,
  now: Date,
): Promise<{ invoices: number; accounts: number }> {
  const cutoffYear = now.getUTCFullYear() - 7;
  const cutoff = `${cutoffYear}-01-01`;
  return retentionDb.withSystem("billing:retention", {}, async (tx) => {
    // Invoices of years past the period whose credit notes are past it too.
    const { rows } = await tx.execute<{ id: string; pdf_object_key: string | null }>(sql`
      WITH old AS (
        SELECT i.id FROM billing.invoices i
        WHERE coalesce(i.issued_at, i.period_end) < ${cutoff}::date
          AND NOT EXISTS (
            SELECT 1 FROM billing.invoices c
            WHERE (c.credited_invoice_id = i.id OR c.id = i.credited_invoice_id)
              AND coalesce(c.issued_at, c.period_end) >= ${cutoff}::date)
      ),
      payments AS (DELETE FROM billing.payments WHERE invoice_id IN (SELECT id FROM old)),
      lines AS (DELETE FROM billing.invoice_lines WHERE invoice_id IN (SELECT id FROM old))
      SELECT i.id, i.pdf_object_key FROM billing.invoices i WHERE i.id IN (SELECT id FROM old)`);
    // Credit notes first (they reference the invoices they correct).
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      const list = `{${ids.join(",")}}`;
      await tx.execute(sql`
        DELETE FROM billing.invoices WHERE id = ANY (${list}::uuid[]) AND credited_invoice_id IS NOT NULL`);
      await tx.execute(sql`DELETE FROM billing.invoices WHERE id = ANY (${list}::uuid[])`);
    }
    for (const r of rows) {
      if (r.pdf_object_key && storage) await storage.deleteObject(r.pdf_object_key);
    }
    const accounts = await tx.execute(sql`
      UPDATE billing.accounts a SET invoice_email = NULL, reference = NULL
      WHERE (a.invoice_email IS NOT NULL OR a.reference IS NOT NULL)
        AND a.updated_at < ${cutoff}::date
        AND NOT EXISTS (
          SELECT 1 FROM billing.invoices i
          WHERE i.club_id = a.club_id AND coalesce(i.issued_at, i.period_end) >= ${cutoff}::date)`);
    return { invoices: ids.length, accounts: accounts.rowCount ?? 0 };
  });
}

export function billingRetentionTask(
  retentionDb: Database | null,
  storage: ObjectStorage | null,
): Task {
  return async (_payload, helpers) => {
    if (!retentionDb) {
      helpers.logger.error("DATABASE_RETENTION_URL is not set: billing retention does nothing");
      return;
    }
    const result = await runBillingRetention(retentionDb, storage, new Date());
    helpers.logger.info("billing: retention", result);
  };
}

// --- Card payments (P1.13 part B) -----------------------------------------------------

const ChargePayload = z.object({ clubId: z.uuid(), invoiceId: z.uuid() });

/**
 * billing:charge: one card attempt for an open card invoice whose attempt is
 * due (at issue, then days 1, 3 and 7). The provider is called outside any
 * transaction, with an idempotency key per invoice and attempt; the outcome
 * is recorded by the ledger. The club is told on the first and the last
 * failure (the invoice can still be paid by bankgiro or the pay link).
 */
export async function runCardCharge(
  db: Database,
  provider: PaymentProvider,
  payload: { clubId: string; invoiceId: string },
  now: Date,
): Promise<"charged" | "failed" | "pending" | "skipped"> {
  const { clubId, invoiceId } = payload;
  const due = await db.withSystem("billing:charge", { clubId }, async (tx) => {
    const { rows } = await tx.execute<{
      status: string;
      next_card_attempt_at: Date | null;
      card_attempts: number;
      currency: string;
      customer: string | null;
      method: string | null;
      provider: string | null;
    }>(sql`
      SELECT i.status, i.next_card_attempt_at, i.card_attempts, i.currency,
        a.provider_customer_id AS customer, a.provider_payment_method_id AS method, a.provider
      FROM billing.invoices i LEFT JOIN billing.accounts a ON a.club_id = i.club_id
      WHERE i.id = ${invoiceId}`);
    const row = rows[0];
    if (!row || row.status !== "open" || !row.next_card_attempt_at) return null;
    if (new Date(row.next_card_attempt_at).getTime() > now.getTime()) return null;
    if (!row.customer || !row.method || row.provider !== provider.name) return null;
    const [invoice] = await tx
      .select()
      .from(tables.billingInvoices)
      .where(eq(tables.billingInvoices.id, invoiceId));
    if (!invoice) return null;
    const balance = await ledger.balanceOf(tx, invoice);
    return balance > 0
      ? {
          customer: row.customer,
          method: row.method,
          currency: row.currency,
          attempt: row.card_attempts + 1,
          balance,
        }
      : null;
  });
  if (!due) return "skipped";
  const result = await provider.charge({
    clubId,
    invoiceId,
    customerId: due.customer,
    paymentMethodId: due.method,
    amountMinor: due.balance,
    currency: due.currency,
    idempotencyKey: `invoice-${invoiceId}-${due.attempt}`,
  });
  await db.withSystem("billing:charge", { clubId }, async (tx) => {
    const outcome = await ledger.recordCardAttempt(tx, {
      invoiceId,
      status: result.status,
      reference: result.reference,
      amountMinor: due.balance,
      failureCode: result.failureCode,
      now,
    });
    if (outcome.notify) {
      await outbox.publish(
        tx,
        "billing.card.failed",
        { clubId, invoiceId, final: outcome.notify === "final_failure" },
        { idempotencyKey: `billing:card-failed:${invoiceId}:${outcome.notify}` },
      );
    }
  });
  return result.status === "succeeded" ? "charged" : result.status;
}

export function chargeTask(db: Database, provider: PaymentProvider | null): Task {
  return async (payload, helpers) => {
    if (!provider) return;
    const result = await runCardCharge(db, provider, ChargePayload.parse(payload), new Date());
    helpers.logger.info("billing: card charge", { result });
  };
}

/** Card invoices due for an attempt (after billing:daily; at most 1,000 per run). */
export async function enqueueDueCharges(db: Database, now: Date): Promise<number> {
  return db.withSystem("billing:daily", {}, async (tx) => {
    const due = await ledger.dueCardCharges(tx, now, 1000);
    for (const d of due) {
      await tx.execute(sql`
        SELECT graphile_worker.add_job('billing:charge', ${JSON.stringify(d)}::json,
          job_key := ${`billing:charge:${d.invoiceId}`}, max_attempts := 3)`);
    }
    // Provider events are kept 90 days (their IDs only).
    await tx.execute(sql`
      DELETE FROM billing.provider_events WHERE received_at < ${new Date(now.getTime() - 90 * 86_400_000)}`);
    return due.length;
  });
}

const EventPayload = z.object({ eventRowId: z.uuid() });

/**
 * billing:provider_event: a verified webhook, fetched again from the provider
 * by its ID: a saved card becomes the club's payment method; a succeeded
 * payment settles its invoice (idempotent by the provider's reference).
 */
export async function runProviderEvent(
  db: Database,
  provider: PaymentProvider,
  eventRowId: string,
  now: Date,
): Promise<string> {
  const row = await db.withSystem("billing:provider_event", {}, async (tx) => {
    const { rows } = await tx.execute<{
      provider: string;
      event_id: string;
      processed_at: Date | null;
    }>(
      sql`SELECT provider, event_id, processed_at FROM billing.provider_events WHERE id = ${eventRowId}`,
    );
    return rows[0] ?? null;
  });
  if (!row || row.processed_at || row.provider !== provider.name) return "skipped";
  const event = await provider.fetchEvent(row.event_id);
  let errorCode: string | null = null;
  if (event.kind === "card_saved") {
    await db.withSystem("billing:provider_event", { clubId: event.clubId }, async (tx) => {
      await tx.execute(sql`
        UPDATE billing.accounts SET payment_method = 'card', provider = ${provider.name},
          provider_customer_id = ${event.customerId},
          provider_payment_method_id = ${event.card.paymentMethodId},
          card_brand = ${event.card.brand}, card_last4 = ${event.card.last4},
          card_exp_month = ${event.card.expMonth}, card_exp_year = ${event.card.expYear}
        WHERE club_id = ${event.clubId}`);
      await audit.record(tx, {
        action: "billing.account.updated",
        resourceType: "billing_account",
        resourceId: event.clubId,
        changedFields: ["payment_method", "provider_payment_method_id", "card"],
      });
    });
  } else if (event.kind === "payment_succeeded") {
    try {
      await db.withSystem("billing:provider_event", { clubId: event.clubId }, (tx) =>
        ledger.recordPayment(tx, {
          invoiceId: event.invoiceId,
          provider: "card",
          reference: event.reference,
          amountMinor: event.amountMinor,
          receivedOn: now.toISOString().slice(0, 10),
          status: "succeeded",
          now,
        }),
      );
    } catch (error) {
      // An overpayment or a closed invoice: recorded for the operators, never retried.
      if (!(error instanceof LedgerError)) throw error;
      errorCode = error.code;
    }
  }
  await db.withSystem("billing:provider_event", {}, (tx) =>
    tx.execute(sql`
      UPDATE billing.provider_events SET processed_at = ${now}, error_code = ${errorCode}
      WHERE id = ${eventRowId}`),
  );
  return event.kind;
}

export function providerEventTask(db: Database, provider: PaymentProvider | null): Task {
  return async (payload, helpers) => {
    if (!provider) return;
    const result = await runProviderEvent(
      db,
      provider,
      EventPayload.parse(payload).eventRowId,
      new Date(),
    );
    helpers.logger.info("billing: provider event", { result });
  };
}
