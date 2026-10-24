// SPDX-License-Identifier: AGPL-3.0-only
// Jobs that run in the API process (ADR 0033) because they act through the
// domain services, which live here: member imports, and expiring event
// offers (P1.6, ADR 0038). A Graphile Worker runner with only these tasks
// shares the queue with the worker app, which never picks them up (each
// runner fetches only the tasks it knows). Payloads are IDs only.

import type { Logger } from "@clubadmin/server-kit";
import { z } from "@clubadmin/shared";
import {
  Logger as GraphileLogger,
  type LogLevel,
  run,
  type Runner,
  type TaskList,
} from "graphile-worker";

import type { EventsService } from "../../modules/events/index.ts";
import type { MemberImportsService } from "../../modules/members/index.ts";

const ImportPayload = z.object({ importId: z.uuid(), clubId: z.uuid() });

export function memberImportTasks(imports: MemberImportsService): TaskList {
  return {
    "members:import_parse": async (payload) => {
      const { importId, clubId } = ImportPayload.parse(payload);
      await imports.parseJob(importId, clubId);
    },
    "members:import_run": async (payload) => {
      const { importId, clubId } = ImportPayload.parse(payload);
      await imports.runJob(importId, clubId);
    },
  };
}

/** Offers expired per run; the next run (every minute) takes the rest. */
const OFFERS_PER_RUN = 500;

export function eventTasks(events: EventsService): TaskList {
  return {
    // Each offer expires in its own transaction, and offers the place to the next one.
    "events:expire_offers": async () => {
      for (const due of await events.dueOffers(OFFERS_PER_RUN)) {
        await events.expireOffer(due.clubId, due.id);
      }
    },
  };
}

/** Every minute: an offer is answered by its time to the minute. */
export const API_CRONTAB = "* * * * * events:expire_offers ?max=1";

function graphileLogger(logger: Logger): GraphileLogger {
  return new GraphileLogger(
    (scope) => (level: LogLevel, message: string, meta?: Record<string, unknown>) => {
      const fields = { ...scope, ...meta };
      if (level === "error") logger.error(fields, message);
      else if (level === "warning") logger.warn(fields, message);
      else logger.debug(fields, message);
    },
  );
}

export function startApiJobs(options: {
  databaseUrl: string;
  concurrency: number;
  imports: MemberImportsService;
  events: EventsService;
  logger: Logger;
}): Promise<Runner> {
  return run({
    connectionString: options.databaseUrl,
    concurrency: options.concurrency,
    noHandleSignals: true,
    logger: graphileLogger(options.logger),
    taskList: { ...memberImportTasks(options.imports), ...eventTasks(options.events) },
    crontab: API_CRONTAB,
  });
}
