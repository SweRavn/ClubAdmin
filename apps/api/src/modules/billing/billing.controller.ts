// SPDX-License-Identifier: AGPL-3.0-only
// Billing routes: registered only with BILLING_ENABLED=true.
import {
  type AssignPlanRequest,
  AssignPlanRequestSchema,
  ClubParamsSchema,
  type Plan,
  PlanListSchema,
  type Subscription,
  SubscriptionResponseSchema,
  type SubscriptionStatusRequest,
  SubscriptionStatusRequestSchema,
} from "@clubadmin/shared";
import { Body, Controller } from "@nestjs/common";

import { Endpoint } from "../../platform/http/endpoint.ts";
import {
  CurrentAuthorization,
  type RequestAuthorization,
  resourceOf,
  tenantContext,
} from "../authorization/index.ts";
import { operatorTenant } from "../authorization/index.ts";
import { BillingService } from "./billing.service.ts";

@Controller()
export class BillingController {
  private readonly billing: BillingService;

  constructor(billing: BillingService) {
    this.billing = billing;
  }

  @Endpoint({
    method: "GET",
    path: "billing/plans",
    summary: "Plans and add-ons with what they grant (operators)",
    tags: ["billing", "ops"],
    access: { permission: "billing.plans.read", resource: "platform" },
    response: PlanListSchema,
  })
  async plans(
    @CurrentAuthorization() authorization: RequestAuthorization,
  ): Promise<{ plans: Plan[] }> {
    return {
      plans: await this.billing.listPlans({ ...authorization.context, actorKind: "operator" }),
    };
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
    const { clubId } = resourceOf(authorization, "club");
    const context = authorization.actor.isOperator()
      ? operatorTenant(authorization.context, clubId)
      : tenantContext(authorization, clubId);
    return { subscription: await this.billing.getSubscription(context) };
  }

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
}
