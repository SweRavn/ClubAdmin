// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  formEncode,
  paymentsConfigIssues,
  stripeProvider,
  stripeSignature,
  verifyStripeSignature,
  WebhookSignatureError,
} from "./payments.ts";

const secret = "whsec_test_secret";
const body = Buffer.from(JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded" }));

describe("webhook signatures", () => {
  it("accepts a valid signature and returns the event's ID and type only", () => {
    const now = Date.now();
    const header = stripeSignature(secret, body, Math.floor(now / 1000));
    expect(verifyStripeSignature(secret, body, header, now)).toEqual({
      eventId: "evt_1",
      type: "payment_intent.succeeded",
    });
  });

  it("refuses a wrong secret, a changed body, an old timestamp and a missing header", () => {
    const now = Date.now();
    const t = Math.floor(now / 1000);
    const bad = (fn: () => unknown) => expect(fn).toThrow(WebhookSignatureError);
    bad(() => verifyStripeSignature(secret, body, stripeSignature("other", body, t), now));
    bad(() =>
      verifyStripeSignature(secret, Buffer.from("{}"), stripeSignature(secret, body, t), now),
    );
    bad(() => verifyStripeSignature(secret, body, stripeSignature(secret, body, t - 600), now));
    bad(() => verifyStripeSignature(secret, body, undefined, now));
  });
});

describe("stripe adapter", () => {
  it("charges off-session with an idempotency key and maps a decline", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const provider = stripeProvider({
      secretKey: "sk_test",
      webhookSecret: secret,
      apiUrl: "https://stripe.test",
      fetch: (url, init) => {
        calls.push({ url, init });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: "card_declined",
                decline_code: "insufficient_funds",
                payment_intent: { id: "pi_1" },
              },
            }),
            { status: 402 },
          ),
        );
      },
    });
    const result = await provider.charge({
      clubId: "c",
      invoiceId: "i",
      customerId: "cus_1",
      paymentMethodId: "pm_1",
      amountMinor: 62_375,
      currency: "SEK",
      idempotencyKey: "invoice-i-1",
    });
    expect(result).toEqual({
      status: "failed",
      reference: "pi_1",
      failureCode: "insufficient_funds",
    });
    expect(calls[0]!.url).toBe("https://stripe.test/v1/payment_intents");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toBe("invoice-i-1");
    const sent = calls[0]!.init.body as string;
    expect(sent).toContain("off_session=true");
    expect(sent).toContain("currency=sek");
  });

  it("encodes nested keys", () => {
    expect(formEncode({ "metadata[club_id]": "x y", skip: undefined })).toBe(
      "metadata%5Bclub_id%5D=x%20y",
    );
  });
});

describe("configuration", () => {
  it("needs keys for stripe and refuses the fake provider in production", () => {
    expect(
      paymentsConfigIssues({ NODE_ENV: "production", BILLING_CARD_PROVIDER: "stripe" }).map(
        (i) => i.variable,
      ),
    ).toEqual(["BILLING_CARD_SECRET_KEY", "BILLING_CARD_WEBHOOK_SECRET"]);
    expect(
      paymentsConfigIssues({ NODE_ENV: "production", BILLING_CARD_PROVIDER: "fake" }),
    ).toHaveLength(1);
    expect(
      paymentsConfigIssues({ NODE_ENV: "development", BILLING_CARD_PROVIDER: "fake" }),
    ).toEqual([]);
  });
});
