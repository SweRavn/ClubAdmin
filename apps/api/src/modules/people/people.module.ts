// SPDX-License-Identifier: AGPL-3.0-only
import { Module } from "@nestjs/common";

import { FIELD_ENCRYPTION, type FieldEncryption } from "../../platform/crypto/field-encryption.ts";
import { DATABASE, type OptionalDatabase, requireDatabase } from "../../platform/infra/database.ts";
import { PeopleService } from "./people.service.ts";

@Module({
  providers: [
    {
      provide: PeopleService,
      inject: [DATABASE, FIELD_ENCRYPTION],
      useFactory: (db: OptionalDatabase, encryption: FieldEncryption) =>
        new PeopleService(requireDatabase(db), encryption),
    },
  ],
  exports: [PeopleService],
})
export class PeopleModule {}
