// SPDX-License-Identifier: AGPL-3.0-only
// Payment provider webhooks (P1.13 part B; BILLING_ENABLED only): public,
// verified on the raw body by the provider's adapter, recorded by event ID
// and processed by the worker. Rate-limited per address; never logs the body.
import { WebhookAckSchema, WebhookParamsSchema, type z } from "@clubadmin/shared";
import type { RawBodyRequest } from "@nestjs/common";
import { Controller, Param, Req } from "@nestjs/common";
import type { FastifyRequest } from "fastify";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { Endpoint } from "../../platform/http/endpoint.ts";
import { BillingService } from "./billing.service.ts";

@Controller()
export class BillingWebhookController {
  private readonly billing: BillingService;

  constructor(billing: BillingService) {
    this.billing = billing;
  }

  @Endpoint({
    method: "POST",
    path: "billing/webhooks/:provider",
    summary: "A payment provider's webhook (signature verified, recorded by event ID)",
    tags: ["billing"],
    access: { public: true },
    request: { params: WebhookParamsSchema },
    response: WebhookAckSchema,
    status: 200,
    rateLimit: { max: 600, timeWindowMs: 60_000 },
  })
  async receive(
    @Param() params: z.infer<typeof WebhookParamsSchema>,
    @Req() request: RawBodyRequest<FastifyRequest>,
  ): Promise<{ received: boolean }> {
    if (!request.rawBody) throw new DomainError("provider_signature_invalid");
    await this.billing.receiveWebhook(params.provider, request.rawBody, request.headers);
    return { received: true };
  }
}
