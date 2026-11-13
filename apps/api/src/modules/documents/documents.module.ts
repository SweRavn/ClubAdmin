// SPDX-License-Identifier: AGPL-3.0-only
import { DOCUMENT_DEFAULT_CLUB_LIMIT_BYTES } from "@clubadmin/shared";
import { Module } from "@nestjs/common";

import { API_CONFIG, type ApiConfig } from "../../config.ts";
import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { OBJECT_STORAGE, type OptionalObjectStorage } from "../../platform/infra/object-storage.ts";
import { AuthorizationModule } from "../authorization/index.ts";
import { EntitlementsService } from "../entitlements/index.ts";
import { PeopleModule } from "../people/index.ts";
import { DocumentsController } from "./documents.controller.ts";
import { DocumentsService } from "./documents.service.ts";

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

@Module({
  imports: [AuthorizationModule, PeopleModule],
  controllers: [DocumentsController],
  providers: [
    {
      provide: DocumentsService,
      inject: [DATABASE, OBJECT_STORAGE, EntitlementsService, API_CONFIG],
      useFactory: (
        db: OptionalDatabase,
        storage: OptionalObjectStorage,
        entitlements: EntitlementsService,
        config: ApiConfig,
      ) =>
        new DocumentsService(requireDatabase(db), {
          storage,
          // The plan's limit (billing on), else the installation's (default 100 MB).
          clubLimitBytes: async (clubId) => {
            const gb = await entitlements.limit(clubId, "storage_gb");
            if (gb !== null) return gb * GB;
            return config.DOCUMENTS_CLUB_LIMIT_MB * MB || DOCUMENT_DEFAULT_CLUB_LIMIT_BYTES;
          },
        }),
    },
  ],
  exports: [DocumentsService],
})
export class DocumentsModule {}
