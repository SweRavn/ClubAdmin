// SPDX-License-Identifier: AGPL-3.0-only
// Extension points for P1.13 (payment providers, invoices). No implementation
// yet: the billing skeleton only defines what they will plug into.

/** Collects payments for invoices (Stripe first; invoice with bank transfer as the alternative). */
export interface PaymentProvider {
  readonly name: string;
  /** Starts collecting an issued invoice; returns the provider's reference. */
  collect(invoice: { id: string; clubId: string; currency: string; totalMinor: number }): Promise<{
    reference: string;
  }>;
  /** Payment status as the provider reports it. */
  status(reference: string): Promise<"pending" | "paid" | "failed">;
}

/** Creates the invoice (and its lines) for a club's subscription period. */
export interface InvoiceGenerator {
  generate(input: { clubId: string; periodStart: Date; periodEnd: Date }): Promise<{
    invoiceId: string;
  } | null>;
}
