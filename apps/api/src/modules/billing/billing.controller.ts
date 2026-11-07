// SPDX-License-Identifier: AGPL-3.0-only
// Billing routes of a club (registered only with BILLING_ENABLED=true): the
// subscription, plans, the club manager's choice, billing details and
// invoices. They are exempt from the club's access state, so a read-only club
// can still pay and fix its details; PDFs count as exports. The operators'
// routes are in billing-ops.controller.ts.
import {
  type AssignPlanRequest,
  AssignPlanRequestSchema,
  type BillingAccount,
  type BillingAccountInput,
  BillingAccountInputSchema,
  BillingAccountResponseSchema,
  ClubParamsSchema,
  type ClubPlans,
  ClubPlansSchema,
  DownloadUrlSchema,
  type InvoiceDetail,
  InvoiceDetailSchema,
  InvoiceListQuerySchema,
  type InvoicePage,
  InvoicePageSchema,
  InvoiceParamsSchema,
  PaymentMethodRequestSchema,
  PaymentMethodResultSchema,
  type SelectPlanInput,
  SelectPlanSchema,
  type Subscription,
  SubscriptionResponseSchema,
  type SubscriptionStatusRequest,
  SubscriptionStatusRequestSchema,
  TrialChangeSchema,
  type z,
} from "@clubadmin/shared";
import { Body, Controller, Param, Query } from "@nestjs/common";

import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  CurrentAuthorization,
  operatorTenant,
  type RequestAuthorization,
  resourceOf,
  tenantContext,
} from "../authorization/index.ts";
import { BillingService } from "./billing.service.ts";

@Controller()
export class BillingController {
  private readonly billing: BillingService;

  constructor(billing: BillingService) {
    this.billing = billing;
  }

  /** Operators work in the club as operators; club roles in their own club. */
  private context(authorization: RequestAuthorization) {
    const { clubId } = resourceOf(authorization, "club");
    return authorization.actor.isOperator()
      ? operatorTenant(authorization.context, clubId)
      : tenantContext(authorization, clubId);
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/subscription",
    summary: "The club's subscription (club managers, treasurers, operators)",
    tags: ["billing"],
    access: { permission: "billing.subscription.read", resource: "club" },
    request: { params: ClubParamsSchema },
    response: SubscriptionResponseSchema,
    clubAccess: "exempt",
  })
  async subscription(
    @CurrentAuthorization() authorization: RequestAuthorization,
  ): Promise<{ subscription: Subscription | null }> {
    return { subscription: await this.billing.getSubscription(this.context(authorization)) };
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/billing/plans",
    summary: "Plans and add-ons the club can choose, with prices excluding and including VAT",
    tags: ["billing"],
    access: { permission: "billing.subscription.read", resource: "club" },
    request: { params: ClubParamsSchema },
    response: ClubPlansSchema,
    clubAccess: "exempt",
  })
  clubPlans(@CurrentAuthorization() authorization: RequestAuthorization): Promise<ClubPlans> {
    return this.billing.clubPlans(this.context(authorization));
  }

  @Endpoint({
    method: "PUT",
    path: "clubs/:clubId/subscription/selection",
    summary:
      "Choose a plan, add-ons and billing period (club managers, MFA): upgrades at once, the rest at the period end",
    tags: ["billing"],
    access: { permission: "billing.subscription.change", resource: "club" },
    request: { params: ClubParamsSchema, body: SelectPlanSchema },
    response: SubscriptionResponseSchema,
    status: 200,
    clubAccess: "exempt",
  })
  async select(
    @CurrentAuthorization() authorization: RequestAuthorization,
    @Body() body: SelectPlanInput,
  ): Promise<{ subscription: Subscription }> {
    const { clubId } = resourceOf(authorization, "club");
    return {
      subscription: await this.billing.select(tenantContext(authorization, clubId), body),
    };
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/subscription/cancel",
    summary: "Cancel at the period end (club managers, MFA); the club falls back to the default plan",
    tags: ["billing"],
    access: { permission: "billing.subscription.change", resource: "club" },
    request: { params: ClubParamsSchema },
    response: SubscriptionResponseSchema,
    status: 200,
    clubAccess: "exempt",
  })
  async cancel(
    @CurrentAuthorization() authorization: RequestAuthorization,
  ): Promise<{ subscription: Subscription }> {
    const { clubId } = resourceOf(authorization, "club");
    return { subscription: await this.billing.cancel(tenantContext(authorization, clubId)) };
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/subscription/resume",
    summary: "Undo a pending cancellation or scheduled change (club managers, MFA)",
    tags: ["billing"],
    access: { permission: "billing.subscription.change", resource: "club" },
    request: { params: ClubParamsSchema },
    response: SubscriptionResponseSchema,
    status: 200,
    clubAccess: "exempt",
  })
  async resume(
    @CurrentAuthorization() authorization: RequestAuthorization,
  ): Promise<{ subscription: Subscription }> {
    const { clubId } = resourceOf(authorization, "club");
    return { subscription: await this.billing.resume(tenantContext(authorization, clubId)) };
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/billing/account",
    summary: "The club's billing details",
    tags: ["billing"],
    access: { permission: "billing.subscription.read", resource: "club" },
    request: { params: ClubParamsSchema },
    response: BillingAccountResponseSchema,
    clubAccess: "exempt",
  })
  async account(
    @CurrentAuthorization() authorization: RequestAuthorization,
  ): Promise<{ account: BillingAccount | null }> {
    return { account: await this.billing.getAccount(this.context(authorization)) };
  }

  @Endpoint({
    method: "PUT",
    path: "clubs/:clubId/billing/account",
    summary: "Set the billing details (club managers and treasurers, MFA)",
    tags: ["billing"],
    access: { permission: "billing.account.manage", resource: "club" },
    request: { params: ClubParamsSchema, body: BillingAccountInputSchema },
    response: BillingAccountResponseSchema,
    status: 200,
    clubAccess: "exempt",
  })
  async putAccount(
    @CurrentAuthorization() authorization: RequestAuthorization,
    @Body() body: BillingAccountInput,
  ): Promise<{ account: BillingAccount }> {
    const { clubId } = resourceOf(authorization, "club");
    return { account: await this.billing.putAccount(tenantContext(authorization, clubId), body) };
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/billing/payment-method",
    summary: "Choose invoice or card (club managers and treasurers, MFA; card: PR B)",
    tags: ["billing"],
    access: { permission: "billing.account.manage", resource: "club" },
    request: { params: ClubParamsSchema, body: PaymentMethodRequestSchema },
    response: PaymentMethodResultSchema,
    status: 200,
    clubAccess: "exempt",
  })
  paymentMethod(
    @CurrentAuthorization() authorization: RequestAuthorization,
    @Body() body: z.infer<typeof PaymentMethodRequestSchema>,
  ) {
    const { clubId } = resourceOf(authorization, "club");
    return this.billing.setPaymentMethod(tenantContext(authorization, clubId), body.method);
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/invoices",
    summary: "The club's invoices and credit notes, newest first",
    tags: ["billing"],
    access: { permission: "billing.invoices.read", resource: "club" },
    request: { params: ClubParamsSchema, query: InvoiceListQuerySchema },
    response: InvoicePageSchema,
    clubAccess: "exempt",
  })
  invoices(
    @CurrentAuthorization() authorization: RequestAuthorization,
    @Query() query: z.infer<typeof InvoiceListQuerySchema>,
  ): Promise<InvoicePage> {
    return this.billing.listInvoices(this.context(authorization), query.cursor ?? null);
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/invoices/:invoiceId",
    summary: "An invoice with lines, VAT, payments and payment instructions",
    tags: ["billing"],
    access: { permission: "billing.invoices.read", resource: "club" },
    request: { params: InvoiceParamsSchema },
    response: InvoiceDetailSchema,
    clubAccess: "exempt",
  })
  invoice(
    @CurrentAuthorization() authorization: RequestAuthorization,
    @Param() params: z.infer<typeof InvoiceParamsSchema>,
  ): Promise<InvoiceDetail> {
    return this.billing.getInvoice(this.context(authorization), params.invoiceId);
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/invoices/:invoiceId/pdf",
    summary: "A download link for the invoice PDF, valid five minutes",
    tags: ["billing"],
    access: { permission: "billing.invoices.read", resource: "club" },
    request: { params: InvoiceParamsSchema },
    response: DownloadUrlSchema,
    clubAccess: "export",
  })
  pdf(
    @CurrentAuthorization() authorization: RequestAuthorization,
    @Param() params: z.infer<typeof InvoiceParamsSchema>,
  ): Promise<{ url: string; expiresAt: string }> {
    return this.billing.invoicePdf(this.context(authorization), params.invoiceId);
  }

  // --- Operators on one club (P0.12, P1.13) ------------------------------------------------

  @Endpoint({
    method: "PUT",
    path: "clubs/:clubId/subscription",
    summary: "Put the club on a plan with add-ons (operators)",
    tags: ["billing", "ops"],
    access: { permission: "billing.subscription.manage", resource: "club" },
    request: { params: ClubParamsSchema, body: AssignPlanRequestSchema },
    response: SubscriptionResponseSchema,
    status: 200,
    clubAccess: "exempt",
  })
  async assignPlan(
    @CurrentAuthorization() authorization: RequestAuthorization,
    @Body() body: AssignPlanRequest,
  ): Promise<{ subscription: Subscription }> {
    const { clubId } = resourceOf(authorization, "club");
    return {
      subscription: await this.billing.assignPlan(
        operatorTenant(authorization.context, clubId),
        body.planKey,
        body.addOns,
      ),
    };
  }

  @Endpoint({
    method: "PUT",
    path: "clubs/:clubId/subscription/status",
    summary:
      "Change the subscription status (operators); read_only makes the club read-only, nothing is deleted",
    tags: ["billing", "ops"],
    access: { permission: "billing.subscription.manage", resource: "club" },
    request: { params: ClubParamsSchema, body: SubscriptionStatusRequestSchema },
    response: SubscriptionResponseSchema,
    status: 200,
    clubAccess: "exempt",
  })
  async changeStatus(
    @CurrentAuthorization() authorization: RequestAuthorization,
    @Body() body: SubscriptionStatusRequest,
  ): Promise<{ subscription: Subscription }> {
    const { clubId } = resourceOf(authorization, "club");
    return {
      subscription: await this.billing.changeStatus(
        operatorTenant(authorization.context, clubId),
        body.status,
      ),
    };
  }

  @Endpoint({
    method: "PUT",
    path: "clubs/:clubId/subscription/trial",
    summary: "Extend or end the club's trial (operators)",
    tags: ["billing", "ops"],
    access: { permission: "billing.subscription.manage", resource: "club" },
    request: { params: ClubParamsSchema, body: TrialChangeSchema },
    response: SubscriptionResponseSchema,
    status: 200,
    clubAccess: "exempt",
  })
  async trial(
    @CurrentAuthorization() authorization: RequestAuthorization,
    @Body() body: z.infer<typeof TrialChangeSchema>,
  ): Promise<{ subscription: Subscription }> {
    const { clubId } = resourceOf(authorization, "club");
    return {
      subscription: await this.billing.setTrial(
        operatorTenant(authorization.context, clubId),
        new Date(body.trialEndsAt),
      ),
    };
  }
}
