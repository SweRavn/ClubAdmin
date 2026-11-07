// SPDX-License-Identifier: AGPL-3.0-only
// The operators' billing routes (BILLING_ENABLED=true; P1.13): the plan
// catalogue, every club's subscription, invoices and payments (club name and
// country only, never member data), bank payments, credit notes, resends
// and the CSV exports for bookkeeping. Operators act as operators, with MFA.
import {
  type CreatePlanInput,
  CreatePlanSchema,
  type CreditNoteInput,
  CreditNoteSchema,
  InvoiceDetailSchema,
  InvoiceIdParamsSchema,
  type InvoicePage,
  InvoicePageSchema,
  OperatorInvoicesQuerySchema,
  OperatorPaymentsQuerySchema,
  OperatorSubscriptionPageSchema,
  OperatorSubscriptionsQuerySchema,
  PaymentPageSchema,
  type Plan,
  PlanListSchema,
  PlanParamsSchema,
  PlanSchema,
  type RecordPaymentInput,
  RecordPaymentSchema,
  type UpdatePlanInput,
  UpdatePlanSchema,
  z,
} from "@clubadmin/shared";
import { Body, Controller, Param, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";

import { Endpoint } from "../../platform/http/endpoint.ts";
import { CurrentAuthorization, type RequestAuthorization } from "../authorization/index.ts";
import { BillingService } from "./billing.service.ts";

/** Rows per CSV export page; an export reads the period page by page. */
const CSV_PAGE = 500;
const CSV_MAX_ROWS = 50_000;

/** A CSV cell: quoted when needed; text never read as a formula (amounts stay numbers). */
export function csvCell(value: string): string {
  const numeric = /^-?\d+(\.\d+)?$/.test(value);
  const safe = !numeric && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const amount = (minor: number) => (minor / 100).toFixed(2);
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "");
const csv = (rows: string[][]) => rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

@Controller()
export class BillingOpsController {
  private readonly billing: BillingService;

  constructor(billing: BillingService) {
    this.billing = billing;
  }

  private operator(authorization: RequestAuthorization) {
    return { ...authorization.context, actorKind: "operator" as const };
  }

  @Endpoint({
    method: "GET",
    path: "billing/plans",
    summary: "Plans and add-ons with prices and what they grant (operators)",
    tags: ["billing", "ops"],
    access: { permission: "billing.plans.read", resource: "platform" },
    response: PlanListSchema,
  })
  async plans(
    @CurrentAuthorization() authorization: RequestAuthorization,
  ): Promise<{ plans: Plan[] }> {
    return { plans: await this.billing.listPlans(this.operator(authorization)) };
  }

  @Endpoint({
    method: "POST",
    path: "billing/plans",
    summary: "Create a plan or add-on with prices and entitlements (operators)",
    tags: ["billing", "ops"],
    access: { permission: "billing.plans.manage", resource: "platform" },
    request: { body: CreatePlanSchema },
    response: PlanSchema,
    status: 201,
  })
  createPlan(
    @CurrentAuthorization() authorization: RequestAuthorization,
    @Body() body: CreatePlanInput,
  ): Promise<Plan> {
    return this.billing.createPlan(this.operator(authorization), body);
  }

  @Endpoint({
    method: "PATCH",
    path: "billing/plans/:planId",
    summary: "Rename, (de)activate, change entitlements, add or deactivate prices (operators)",
    tags: ["billing", "ops"],
    access: { permission: "billing.plans.manage", resource: "platform" },
    request: { params: PlanParamsSchema, body: UpdatePlanSchema },
    response: PlanSchema,
  })
  updatePlan(
    @CurrentAuthorization() authorization: RequestAuthorization,
    @Param() params: z.infer<typeof PlanParamsSchema>,
    @Body() body: UpdatePlanInput,
  ): Promise<Plan> {
    return this.billing.updatePlan(this.operator(authorization), params.planId, body);
  }

  @Endpoint({
    method: "GET",
    path: "billing/subscriptions",
    summary: "Every club's subscription with status, period and balance due (operators)",
    tags: ["billing", "ops"],
    access: { permission: "billing.subscriptions.list", resource: "platform" },
    request: { query: OperatorSubscriptionsQuerySchema },
    response: OperatorSubscriptionPageSchema,
  })
  subscriptions(
    @CurrentAuthorization() authorization: RequestAuthorization,
    @Query() query: z.infer<typeof OperatorSubscriptionsQuerySchema>,
  ) {
    return this.billing.listSubscriptions(this.operator(authorization), query);
  }

  @Endpoint({
    method: "GET",
    path: "billing/invoices",
    summary: "Invoices and credit notes of every club, newest first (operators)",
    tags: ["billing", "ops"],
    access: { permission: "billing.invoices.list", resource: "platform" },
    request: { query: OperatorInvoicesQuerySchema },
    response: InvoicePageSchema,
  })
  invoices(
    @CurrentAuthorization() authorization: RequestAuthorization,
    @Query() query: z.infer<typeof OperatorInvoicesQuerySchema>,
  ): Promise<InvoicePage> {
    return this.billing.listAllInvoices(this.operator(authorization), query);
  }

  @Endpoint({
    method: "GET",
    path: "billing/invoices.csv",
    summary: "The period's invoices and credit notes with VAT for bookkeeping, as CSV (operators)",
    tags: ["billing", "ops"],
    access: { permission: "billing.invoices.list", resource: "platform" },
    request: { query: OperatorInvoicesQuerySchema },
    response: z.string(),
    responseType: "text/csv",
  })
  async invoicesCsv(
    @CurrentAuthorization() authorization: RequestAuthorization,
    @Query() query: z.infer<typeof OperatorInvoicesQuerySchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<string> {
    const rows: string[][] = [
      [
        "number",
        "kind",
        "status",
        "club",
        "country",
        "issued",
        "due",
        "paid",
        "period_start",
        "period_end",
        "currency",
        "subtotal",
        "vat",
        "total",
        "balance",
      ],
    ];
    let cursor = query.cursor;
    for (let read = 0; read < CSV_MAX_ROWS; read += CSV_PAGE) {
      const page = await this.billing.listAllInvoices(
        this.operator(authorization),
        { ...query, cursor },
        CSV_PAGE,
      );
      for (const i of page.items) {
        rows.push([
          i.number ?? "",
          i.kind,
          i.status,
          i.club?.name ?? "",
          i.club?.country ?? "",
          day(i.issuedAt),
          day(i.dueAt),
          day(i.paidAt),
          day(i.periodStart),
          day(i.periodEnd),
          i.currency,
          amount(i.subtotalMinor),
          amount(i.vatMinor),
          amount(i.totalMinor),
          amount(i.balanceMinor),
        ]);
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    void reply.header("content-type", "text/csv; charset=utf-8");
    void reply.header("content-disposition", 'attachment; filename="invoices.csv"');
    void reply.header("cache-control", "no-store");
    return csv(rows);
  }

  @Endpoint({
    method: "GET",
    path: "billing/payments",
    summary: "Payments of every club, newest first (operators)",
    tags: ["billing", "ops"],
    access: { permission: "billing.invoices.list", resource: "platform" },
    request: { query: OperatorPaymentsQuerySchema },
    response: PaymentPageSchema,
  })
  payments(
    @CurrentAuthorization() authorization: RequestAuthorization,
    @Query() query: z.infer<typeof OperatorPaymentsQuerySchema>,
  ) {
    return this.billing.listPayments(this.operator(authorization), query);
  }

  @Endpoint({
    method: "GET",
    path: "billing/payments.csv",
    summary: "The period's payments as CSV (operators)",
    tags: ["billing", "ops"],
    access: { permission: "billing.invoices.list", resource: "platform" },
    request: { query: OperatorPaymentsQuerySchema },
    response: z.string(),
    responseType: "text/csv",
  })
  async paymentsCsv(
    @CurrentAuthorization() authorization: RequestAuthorization,
    @Query() query: z.infer<typeof OperatorPaymentsQuerySchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<string> {
    const rows: string[][] = [
      ["recorded", "received", "club", "invoice", "provider", "status", "currency", "amount"],
    ];
    let cursor = query.cursor;
    for (let read = 0; read < CSV_MAX_ROWS; read += CSV_PAGE) {
      const page = await this.billing.listPayments(
        this.operator(authorization),
        { ...query, cursor },
        CSV_PAGE,
      );
      for (const p of page.items) {
        rows.push([
          day(p.recordedAt),
          p.receivedOn ?? "",
          p.club.name,
          p.invoiceNumber ?? "",
          p.provider,
          p.status,
          p.currency,
          amount(p.amountMinor),
        ]);
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    void reply.header("content-type", "text/csv; charset=utf-8");
    void reply.header("content-disposition", 'attachment; filename="payments.csv"');
    void reply.header("cache-control", "no-store");
    return csv(rows);
  }

  @Endpoint({
    method: "POST",
    path: "billing/invoices/:invoiceId/payments",
    summary: "Record a bank payment against an invoice; idempotent by reference (operators)",
    tags: ["billing", "ops"],
    access: { permission: "billing.invoices.manage", resource: "platform" },
    request: { params: InvoiceIdParamsSchema, body: RecordPaymentSchema },
    response: InvoiceDetailSchema,
    status: 200,
  })
  recordPayment(
    @CurrentAuthorization() authorization: RequestAuthorization,
    @Param() params: z.infer<typeof InvoiceIdParamsSchema>,
    @Body() body: RecordPaymentInput,
  ) {
    return this.billing.recordPayment(this.operator(authorization), params.invoiceId, body);
  }

  @Endpoint({
    method: "POST",
    path: "billing/invoices/:invoiceId/credit-note",
    summary: "Issue a credit note for all or some lines of an invoice (operators)",
    tags: ["billing", "ops"],
    access: { permission: "billing.invoices.manage", resource: "platform" },
    request: { params: InvoiceIdParamsSchema, body: CreditNoteSchema },
    response: InvoiceDetailSchema,
    status: 201,
  })
  creditNote(
    @CurrentAuthorization() authorization: RequestAuthorization,
    @Param() params: z.infer<typeof InvoiceIdParamsSchema>,
    @Body() body: CreditNoteInput,
  ) {
    return this.billing.creditNote(this.operator(authorization), params.invoiceId, body);
  }

  @Endpoint({
    method: "POST",
    path: "billing/invoices/:invoiceId/resend",
    summary: "Email an invoice again to the club's invoice address (operators)",
    tags: ["billing", "ops"],
    access: { permission: "billing.invoices.manage", resource: "platform" },
    request: { params: InvoiceIdParamsSchema },
    response: z.object({}),
    status: 202,
  })
  async resend(
    @CurrentAuthorization() authorization: RequestAuthorization,
    @Param() params: z.infer<typeof InvoiceIdParamsSchema>,
  ): Promise<Record<string, never>> {
    await this.billing.resend(this.operator(authorization), params.invoiceId);
    return {};
  }
}
