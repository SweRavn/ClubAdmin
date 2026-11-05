// SPDX-License-Identifier: AGPL-3.0-only
// The audit module (P1.9, ADR 0042): history panels, the club-wide changes
// and the club's audit log. Reads go through their own database handle
// (HISTORY_DATABASE): a small read-only pool with a statement timeout,
// optionally on a replica, so reading history never takes connections or
// time from the everyday paths.

import { createDatabase, type Database } from "@clubadmin/db";
import { Inject, Module, type OnApplicationShutdown } from "@nestjs/common";

import { API_CONFIG, type ApiConfig } from "../../config.ts";
import { requireDatabase } from "../../platform/infra/database.ts";
import { AuthorizationModule, PersonPresenter } from "../authorization/index.ts";
import { PeopleModule, PeopleService } from "../people/index.ts";
import { AuditController } from "./audit.controller.ts";
import { HistoryService } from "./history.service.ts";

export const HISTORY_DATABASE = Symbol("HISTORY_DATABASE");

export function createHistoryDatabase(config: ApiConfig): Database | undefined {
  const url = config.HISTORY_DATABASE_URL ?? config.DATABASE_URL;
  return url
    ? createDatabase({
        url,
        max: config.HISTORY_POOL_MAX,
        statementTimeoutMs: config.HISTORY_STATEMENT_TIMEOUT_MS,
        readOnly: true,
        applicationName: "clubadmin-api-history",
      })
    : undefined;
}

@Module({
  imports: [AuthorizationModule, PeopleModule],
  controllers: [AuditController],
  providers: [
    {
      provide: HISTORY_DATABASE,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) => createHistoryDatabase(config),
    },
    {
      provide: HistoryService,
      inject: [HISTORY_DATABASE, PeopleService, PersonPresenter, API_CONFIG],
      useFactory: (
        db: Database | undefined,
        people: PeopleService,
        presenter: PersonPresenter,
        config: ApiConfig,
      ) =>
        new HistoryService(requireDatabase(db), people, presenter, {
          historyRetentionMonths: config.HISTORY_RETENTION_MONTHS,
          auditRetentionMonths: config.AUDIT_RETENTION_MONTHS,
        }),
    },
  ],
})
export class AuditModule implements OnApplicationShutdown {
  private readonly db: Database | undefined;

  constructor(@Inject(HISTORY_DATABASE) db: Database | undefined) {
    this.db = db;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.db?.close();
  }
}
