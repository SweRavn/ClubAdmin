// SPDX-License-Identifier: AGPL-3.0-only
// Card payments for billing (P1.13 part B, ADR 0045), shared by the API
// (saving a card, the pay link, webhooks) and the worker (charges at issue
// and retries, processing webhook events). One adapter per provider, chosen
// by BILLING_CARD_PROVIDER: `stripe` through its REST API (no SDK), `fake`
// for development and tests. Card data never reaches us: saving a card and
// paying an invoice happen on the provider's hosted pages (PCI DSS SAQ A).
// Webhook payloads are not stored: events are verified, recorded by ID and
// fetched again from the provider when processed.

import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "@clubadmin/shared";

/** Settings of the card provider (billing on only; api and worker). */
export const paymentsConfigShape = {
  /** stripe, or fake (development and tests only); unset: invoice only. */
  BILLING_CARD_PROVIDER: z.enum(["stripe", "fake"]).optional(),
  BILLING_CARD_SECRET_KEY: z.string().min(1).optional(),
  BILLING_CARD_WEBHOOK_SECRET: z.string().min(1).optional(),
  /** The provider's API (tests point it elsewhere). */
  BILLING_CARD_API_URL: z.url().default("https://api.stripe.com"),
};

export function paymentsConfigIssues(config: {
  NODE_ENV: string;
  BILLING_CARD_PROVIDER?: "stripe" | "fake" | undefined;
  BILLING_CARD_SECRET_KEY?: string | undefined;
  BILLING_CARD_WEBHOOK_SECRET?: string | undefined;
}): { variable: string; message: string }[] {
  const issues: { variable: string; message: string }[] = [];
  if (config.BILLING_CARD_PROVIDER === "fake" && config.NODE_ENV === "production") {
    issues.push({
      variable: "BILLING_CARD_PROVIDER",
      message: "fake is not allowed in production",
    });
  }
  if (config.BILLING_CARD_PROVIDER === "stripe") {
    for (const variable of ["BILLING_CARD_SECRET_KEY", "BILLING_CARD_WEBHOOK_SECRET"] as const) {
      if (!config[variable])
        issues.push({ variable, message: "required with BILLING_CARD_PROVIDER" });
    }
  }
  return issues;
}

export class WebhookSignatureError extends Error {
  constructor() {
    super("provider_signature_invalid");
    this.name = "WebhookSignatureError";
  }
}

export class PaymentProviderError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "PaymentProviderError";
    this.status = status;
  }
}

export interface CardSummary {
  paymentMethodId: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
}

/** A verified webhook, as stored: the provider's event ID and type only. */
export interface VerifiedEvent {
  eventId: string;
  type: string;
}

/** What an event means for billing, fetched from the provider by its ID. */
export type ProviderEvent =
  | { kind: "card_saved"; clubId: string; customerId: string; card: CardSummary }
  | {
      kind: "payment_succeeded";
      clubId: string;
      invoiceId: string;
      reference: string;
      amountMinor: number;
    }
  | { kind: "ignored" };

export interface PaymentProvider {
  readonly name: "stripe" | "fake";
  /** The provider's hosted page for saving a card; creates the customer when needed. */
  setupCard(input: {
    clubId: string;
    customerId: string | null;
    customerName: string;
    customerEmail: string | null;
    returnUrl: string;
    cancelUrl: string;
  }): Promise<{ customerId: string; redirectUrl: string }>;
  /** The provider's hosted page for paying one invoice (the pay link). */
  payInvoice(input: {
    clubId: string;
    invoiceId: string;
    invoiceNumber: string;
    customerId: string | null;
    amountMinor: number;
    currency: string;
    returnUrl: string;
    cancelUrl: string;
  }): Promise<{ redirectUrl: string }>;
  /** Charges the saved card off-session; idempotent by key. */
  charge(input: {
    clubId: string;
    invoiceId: string;
    customerId: string;
    paymentMethodId: string;
    amountMinor: number;
    currency: string;
    idempotencyKey: string;
  }): Promise<{
    status: "succeeded" | "failed" | "pending";
    reference: string;
    failureCode: string | null;
  }>;
  /** Verifies a webhook's signature on the raw body (timestamp tolerance five minutes). */
  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): VerifiedEvent;
  /** The event's meaning, fetched from the provider by its ID. */
  fetchEvent(eventId: string): Promise<ProviderEvent>;
}

const TOLERANCE_SECONDS = 300;

/** Stripe's webhook signature: `t=<unix>,v1=<hex HMAC-SHA256 of "t.body">`. */
export function stripeSignature(secret: string, body: string | Buffer, timestamp: number): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

export function verifyStripeSignature(
  secret: string,
  rawBody: Buffer,
  header: string | string[] | undefined,
  now = Date.now(),
): VerifiedEvent {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new WebhookSignatureError();
  const parts = value.split(",").map((p) => p.split("=", 2) as [string, string]);
  const timestamp = Number(parts.find(([k]) => k === "t")?.[1]);
  const signatures = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!Number.isFinite(timestamp) || signatures.length === 0) throw new WebhookSignatureError();
  if (Math.abs(now / 1000 - timestamp) > TOLERANCE_SECONDS) throw new WebhookSignatureError();
  const expected = Buffer.from(stripeSignature(secret, rawBody, timestamp).split("v1=")[1]!, "hex");
  const ok = signatures.some((s) => {
    const given = Buffer.from(s, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!ok) throw new WebhookSignatureError();
  let event: unknown;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new WebhookSignatureError();
  }
  const parsed = z
    .object({ id: z.string().min(1).max(255), type: z.string().min(1).max(255) })
    .safeParse(event);
  if (!parsed.success) throw new WebhookSignatureError();
  return { eventId: parsed.data.id, type: parsed.data.type };
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Form encoding with Stripe's bracket notation for nested keys. */
export function formEncode(
  values: Record<string, string | number | boolean | undefined | null>,
): string {
  return Object.entries(values)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

/** Stripe through its REST API (form-encoded requests, Bearer secret key). */
export function stripeProvider(options: {
  secretKey: string;
  webhookSecret: string;
  apiUrl?: string;
  fetch?: FetchLike;
}): PaymentProvider {
  const base = options.apiUrl ?? "https://api.stripe.com";
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  async function call(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, string | number | boolean | undefined | null>,
    idempotencyKey?: string,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.secretKey}`,
        ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      ...(body ? { body: formEncode(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const json = obj(await res.json().catch(() => ({})));
    return { status: res.status, json };
  }
  async function ok(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, string | number | boolean | undefined | null>,
    idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    const { status, json } = await call(method, path, body, idempotencyKey);
    if (status >= 400) {
      // Never the message: it may echo customer data.
      throw new PaymentProviderError(
        `stripe ${method} ${path.split("?")[0]} answered ${status}`,
        status,
      );
    }
    return json;
  }
  return {
    name: "stripe",
    async setupCard(input) {
      const customerId =
        input.customerId ??
        str(
          (
            await ok(
              "POST",
              "/v1/customers",
              {
                name: input.customerName,
                email: input.customerEmail,
                "metadata[club_id]": input.clubId,
              },
              `customer-${input.clubId}`,
            )
          ).id,
        );
      if (!customerId) throw new PaymentProviderError("stripe customer without id", 502);
      const session = await ok("POST", "/v1/checkout/sessions", {
        mode: "setup",
        customer: customerId,
        "payment_method_types[0]": "card",
        success_url: input.returnUrl,
        cancel_url: input.cancelUrl,
        "metadata[club_id]": input.clubId,
        "setup_intent_data[metadata][club_id]": input.clubId,
      });
      const url = str(session.url);
      if (!url) throw new PaymentProviderError("stripe session without url", 502);
      return { customerId, redirectUrl: url };
    },
    async payInvoice(input) {
      const session = await ok("POST", "/v1/checkout/sessions", {
        mode: "payment",
        ...(input.customerId ? { customer: input.customerId } : {}),
        "line_items[0][quantity]": 1,
        "line_items[0][price_data][currency]": input.currency.toLowerCase(),
        "line_items[0][price_data][unit_amount]": input.amountMinor,
        "line_items[0][price_data][product_data][name]": input.invoiceNumber,
        success_url: input.returnUrl,
        cancel_url: input.cancelUrl,
        "metadata[club_id]": input.clubId,
        "metadata[invoice_id]": input.invoiceId,
        "payment_intent_data[metadata][club_id]": input.clubId,
        "payment_intent_data[metadata][invoice_id]": input.invoiceId,
      });
      const url = str(session.url);
      if (!url) throw new PaymentProviderError("stripe session without url", 502);
      return { redirectUrl: url };
    },
    async charge(input) {
      const { status, json } = await call(
        "POST",
        "/v1/payment_intents",
        {
          amount: input.amountMinor,
          currency: input.currency.toLowerCase(),
          customer: input.customerId,
          payment_method: input.paymentMethodId,
          off_session: true,
          confirm: true,
          "metadata[club_id]": input.clubId,
          "metadata[invoice_id]": input.invoiceId,
        },
        input.idempotencyKey,
      );
      if (status >= 500) throw new PaymentProviderError(`stripe charge answered ${status}`, status);
      if (status >= 400) {
        const error = obj(json.error);
        const intent = obj(error.payment_intent);
        return {
          status: "failed",
          reference: str(intent.id) ?? `failed:${input.idempotencyKey}`,
          failureCode: str(error.decline_code) ?? str(error.code) ?? "card_error",
        };
      }
      const state = str(json.status);
      return {
        status: state === "succeeded" ? "succeeded" : state === "processing" ? "pending" : "failed",
        reference: str(json.id) ?? `unknown:${input.idempotencyKey}`,
        failureCode: state === "succeeded" || state === "processing" ? null : (state ?? "unknown"),
      };
    },
    verifyWebhook(rawBody, headers) {
      return verifyStripeSignature(options.webhookSecret, rawBody, headers["stripe-signature"]);
    },
    async fetchEvent(eventId) {
      const event = await ok("GET", `/v1/events/${encodeURIComponent(eventId)}`);
      const type = str(event.type);
      const object = obj(obj(event.data).object);
      const metadata = obj(object.metadata);
      if (type === "checkout.session.completed" && object.mode === "setup") {
        const clubId = str(metadata.club_id);
        const customerId = str(object.customer);
        const setupIntent = str(object.setup_intent);
        if (!clubId || !customerId || !setupIntent) return { kind: "ignored" };
        const intent = await ok(
          "GET",
          `/v1/setup_intents/${encodeURIComponent(setupIntent)}?expand[]=payment_method`,
        );
        const method = obj(intent.payment_method);
        const card = obj(method.card);
        const paymentMethodId = str(method.id) ?? str(intent.payment_method);
        if (!paymentMethodId) return { kind: "ignored" };
        return {
          kind: "card_saved",
          clubId,
          customerId,
          card: {
            paymentMethodId,
            brand: str(card.brand),
            last4: str(card.last4),
            expMonth: num(card.exp_month),
            expYear: num(card.exp_year),
          },
        };
      }
      if (type === "payment_intent.succeeded") {
        const clubId = str(metadata.club_id);
        const invoiceId = str(metadata.invoice_id);
        const reference = str(object.id);
        const amount = num(object.amount_received) ?? num(object.amount);
        if (!clubId || !invoiceId || !reference || amount === null) return { kind: "ignored" };
        return { kind: "payment_succeeded", clubId, invoiceId, reference, amountMinor: amount };
      }
      return { kind: "ignored" };
    },
  };
}

/**
 * A provider without a network (development, tests): hosted pages are this
 * site's billing page with a marker; charges succeed unless the invoice is
 * listed in `decline`; events come from `events` (tests). Webhooks use
 * Stripe's signature scheme with the configured secret.
 */
export function fakePaymentProvider(options: {
  webhookSecret: string;
  decline?: Set<string>;
  events?: Map<string, ProviderEvent>;
}): PaymentProvider & { charges: string[] } {
  const charges: string[] = [];
  return {
    name: "fake",
    charges,
    setupCard(input) {
      const sep = input.returnUrl.includes("?") ? "&" : "?";
      return Promise.resolve({
        customerId: input.customerId ?? `cus_fake_${input.clubId.slice(-12)}`,
        redirectUrl: `${input.returnUrl}${sep}fake_provider=setup`,
      });
    },
    payInvoice(input) {
      const sep = input.returnUrl.includes("?") ? "&" : "?";
      return Promise.resolve({ redirectUrl: `${input.returnUrl}${sep}fake_provider=pay` });
    },
    charge(input) {
      charges.push(input.idempotencyKey);
      const declined = options.decline?.has(input.invoiceId) ?? false;
      return Promise.resolve({
        status: declined ? "failed" : "succeeded",
        reference: `pi_fake_${input.idempotencyKey}`,
        failureCode: declined ? "card_declined" : null,
      });
    },
    verifyWebhook(rawBody, headers) {
      return verifyStripeSignature(options.webhookSecret, rawBody, headers["stripe-signature"]);
    },
    fetchEvent(eventId) {
      return Promise.resolve(options.events?.get(eventId) ?? { kind: "ignored" });
    },
  };
}

/** The configured provider, or null (invoice only). */
export function paymentProvider(config: {
  BILLING_CARD_PROVIDER?: "stripe" | "fake" | undefined;
  BILLING_CARD_SECRET_KEY?: string | undefined;
  BILLING_CARD_WEBHOOK_SECRET?: string | undefined;
  BILLING_CARD_API_URL: string;
}): PaymentProvider | null {
  if (config.BILLING_CARD_PROVIDER === "stripe") {
    return stripeProvider({
      secretKey: config.BILLING_CARD_SECRET_KEY ?? "",
      webhookSecret: config.BILLING_CARD_WEBHOOK_SECRET ?? "",
      apiUrl: config.BILLING_CARD_API_URL,
    });
  }
  if (config.BILLING_CARD_PROVIDER === "fake") {
    return fakePaymentProvider({
      webhookSecret: config.BILLING_CARD_WEBHOOK_SECRET ?? "fake-webhook-secret",
    });
  }
  return null;
}
