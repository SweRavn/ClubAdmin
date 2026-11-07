// SPDX-License-Identifier: AGPL-3.0-only
// Handlers for domain events from the transactional outbox. Each runs at most
// once per event; its database work commits together with its delivery
// record. External side effects (email, push, cache versions) must be
// idempotent: use event.idempotencyKey.
import {
  authorizationCacheHandler,
  type CacheVersions,
  type LedgerSettings,
  type OutboxHandler,
} from "@clubadmin/db";
import { AUTHZ_VERSION_TTL_SECONDS } from "@clubadmin/shared";
import type { Redis } from "ioredis";

import {
  billingSelectionHandler,
  billingSendHandler,
  billingTrialHandler,
  entitlementsCacheHandler,
} from "./billing.ts";
import { mailHandler, type MailHandlerOptions } from "./mail.ts";
import { notificationsHandler, type NotificationsOptions } from "./notifications/handler.ts";
import { privacyHandler } from "./tasks/privacy.ts";
import { profileViewsHandler } from "./tasks/profile-views.ts";

/** Version counters in Valkey (INCR is safe to repeat: a newer version only forces a reload). */
export function valkeyCacheVersions(valkey: Redis): CacheVersions {
  return {
    async bump(keys) {
      const pipeline = valkey.multi();
      for (const key of keys) pipeline.incr(key).expire(key, AUTHZ_VERSION_TTL_SECONDS);
      const results = await pipeline.exec();
      const failed = results?.find(([error]) => error);
      if (!results || failed) throw failed?.[0] ?? new Error("cache version bump failed");
    },
  };
}

export function createOutboxHandlers(deps: {
  valkey?: Redis | undefined;
  /**
   * Billing on (P0.12, P1.13): trials for new clubs on the hosted service, a
   * club manager's selection applied at once, invoices emailed.
   */
  billing?:
    | { hosted: boolean; trialPlan: string; trialDays: number; settings: LedgerSettings }
    | undefined;
  /** Transactional email (P1.1); without SMTP_URL no email is sent. */
  mail?: MailHandlerOptions | undefined;
  /** Notifications (P1.7): the inbox always, email and push per the channels. */
  notifications?: NotificationsOptions | undefined;
}): OutboxHandler[] {
  const handlers: OutboxHandler[] = [privacyHandler(), profileViewsHandler()];
  if (deps.mail) handlers.push(mailHandler(deps.mail));
  if (deps.notifications) handlers.push(notificationsHandler(deps.notifications));
  // Without Valkey the API caches nothing across requests, so there is nothing to invalidate.
  if (deps.valkey) {
    handlers.push(
      authorizationCacheHandler(valkeyCacheVersions(deps.valkey)),
      entitlementsCacheHandler(deps.valkey),
    );
  }
  if (deps.billing) {
    handlers.push(billingSelectionHandler(deps.billing.settings), billingSendHandler());
  }
  if (deps.billing?.hosted) {
    handlers.push(
      billingTrialHandler({
        trialPlan: deps.billing.trialPlan,
        trialDays: deps.billing.trialDays,
        valkey: deps.valkey,
      }),
    );
  }
  return handlers;
}
