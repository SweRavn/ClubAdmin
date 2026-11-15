// SPDX-License-Identifier: AGPL-3.0-only
import { inAppSignatureProvider } from "@clubadmin/server-kit/signatures";
import { DOCUMENT_DEFAULT_CLUB_LIMIT_BYTES } from "@clubadmin/shared";
import { Module } from "@nestjs/common";

import { API_CONFIG, type ApiConfig } from "../../config.ts";
import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { OBJECT_STORAGE, type OptionalObjectStorage } from "../../platform/infra/object-storage.ts";
import { AuthorizationModule } from "../authorization/index.ts";
import { EntitlementsService } from "../entitlements/index.ts";
import { MembershipsModule, MembershipsService } from "../memberships/index.ts";
import { PeopleModule } from "../people/index.ts";
import { ClubPrivacyService } from "../privacy/index.ts";
import { DocumentsController } from "./documents.controller.ts";
import { DocumentsService } from "./documents.service.ts";
import { GoverningController } from "./governing.controller.ts";
import { GoverningService } from "./governing.service.ts";
import { NoticeAttachmentsController } from "./notice-attachments.controller.ts";

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

@Module({
  imports: [AuthorizationModule, PeopleModule, MembershipsModule],
  controllers: [DocumentsController, NoticeAttachmentsController, GoverningController],
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
    {
      // Governing documents (P2.4): adopting records board decisions (ClubPrivacyService, global).
      provide: GoverningService,
      inject: [DATABASE, ClubPrivacyService, OBJECT_STORAGE, MembershipsService],
      useFactory: (
        db: OptionalDatabase,
        privacy: ClubPrivacyService,
        storage: OptionalObjectStorage,
        memberships: MembershipsService,
      ) =>
        new GoverningService(requireDatabase(db), {
          privacy,
          // Simple electronic signatures in the app (BankID, Freja later: ADR 0049).
          signer: inAppSignatureProvider(),
          storage,
          isMember: (tx, clubId, personId) => memberships.isMemberInTx(tx, clubId, personId),
        }),
    },
  ],
  exports: [DocumentsService, GoverningService],
})
export class DocumentsModule {}
