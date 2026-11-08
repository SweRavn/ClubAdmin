// SPDX-License-Identifier: AGPL-3.0-only
import { createDatabase } from "@clubadmin/db";
import { createLogger, loadEnvFiles, onShutdown } from "@clubadmin/server-kit";

import { createApp } from "./app.ts";
import { loadApiConfig } from "./config.ts";
import { ActivitiesService } from "./modules/activities/index.ts";
import { AuthorizationService, PersonPresenter } from "./modules/authorization/index.ts";
import { EventsService } from "./modules/events/index.ts";
import { GuardianshipsService } from "./modules/guardianships/index.ts";
import { SessionsService, zitadelUsers } from "./modules/identity/index.ts";
import { MemberImportsService } from "./modules/members/index.ts";
import { PeopleService } from "./modules/people/index.ts";
import {
  LeavingService,
  OUTSTANDING_OBLIGATIONS,
  type OutstandingObligationsProvider,
} from "./modules/privacy/index.ts";
import { DATABASE, requireDatabase } from "./platform/infra/database.ts";
import { OBJECT_STORAGE, type OptionalObjectStorage } from "./platform/infra/object-storage.ts";
import { startApiJobs } from "./platform/jobs/api-jobs.ts";

loadEnvFiles();
const config = loadApiConfig();
const logger = createLogger({ service: "clubadmin-api", level: config.LOG_LEVEL });

const app = await createApp(config, { logger });
await app.listen({ host: config.API_HOST, port: config.API_PORT });
logger.info(
  { host: config.API_HOST, port: config.API_PORT, nodeEnv: config.NODE_ENV },
  "api listening",
);

// Jobs that use the domain services run here (ADR 0033): member imports
// (P1.3b), expiring event offers (P1.6), "download my data" and erasure
// (P1.8b; the erasure runs privacy.erase_person as clubadmin_retention).
const retentionDb =
  config.MEMBER_IMPORT_JOBS && config.DATABASE_RETENTION_URL
    ? createDatabase({ url: config.DATABASE_RETENTION_URL, max: 1 })
    : null;
const importJobs =
  config.MEMBER_IMPORT_JOBS && config.DATABASE_URL
    ? await startApiJobs({
        databaseUrl: config.DATABASE_URL,
        concurrency: config.MEMBER_IMPORT_CONCURRENCY,
        imports: app.get(MemberImportsService),
        events: app.get(EventsService),
        activities: app.get(ActivitiesService),
        ...privacyJobDeps(),
        logger,
      })
    : null;

function privacyJobDeps() {
  const db = requireDatabase(app.get(DATABASE));
  const storage = app.get<OptionalObjectStorage>(OBJECT_STORAGE);
  const zitadelUrl = config.ZITADEL_API_URL ?? config.AUTH_ISSUER;
  return {
    exports: {
      db,
      retentionDb,
      storage,
      people: app.get(PeopleService),
      events: app.get(EventsService),
      presenter: app.get(PersonPresenter),
      authorization: app.get(AuthorizationService),
    },
    erasure: {
      db,
      retentionDb,
      storage,
      leaving: app.get(LeavingService),
      guardianships: app.get(GuardianshipsService),
      obligations: app.get<OutstandingObligationsProvider[]>(OUTSTANDING_OBLIGATIONS),
      sessions: app.get(SessionsService),
      zitadelUsers:
        zitadelUrl && config.ZITADEL_API_TOKEN
          ? zitadelUsers(zitadelUrl, config.ZITADEL_API_TOKEN)
          : undefined,
    },
  };
}

onShutdown(logger, async () => {
  await importJobs?.stop();
  await retentionDb?.close();
  await app.close();
});
