// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";

import { API_CONFIG, type ApiConfig } from "../../config.ts";
import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { AuthorizationModule } from "../authorization/index.ts";
import { BackupsController } from "./backups.controller.ts";
import { BackupsService } from "./backups.service.ts";

@Module({
  imports: [AuthorizationModule],
  controllers: [BackupsController],
  providers: [
    {
      provide: BackupsService,
      inject: [DATABASE, API_CONFIG],
      useFactory: (db: OptionalDatabase, config: ApiConfig) =>
        new BackupsService(requireDatabase(db), {
          enabled: config.BACKUP_ENABLED,
          thresholds: {
            backupHours: config.BACKUP_WARN_AFTER_HOURS,
            filesHours: config.FILES_BACKUP_WARN_AFTER_HOURS,
            verificationDays: config.RESTORE_VERIFICATION_WARN_AFTER_DAYS,
          },
        }),
    },
  ],
  exports: [BackupsService],
})
export class BackupsModule {}
