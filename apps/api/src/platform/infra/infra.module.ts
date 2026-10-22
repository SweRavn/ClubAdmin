// SPDX-License-Identifier: AGPL-3.0-only
import { Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";

import { API_CONFIG, type ApiConfig } from "../../config.ts";
import { FIELD_ENCRYPTION, FieldEncryption } from "../crypto/field-encryption.ts";
import { createApiDatabase, DATABASE, type OptionalDatabase } from "./database.ts";
import { createObjectStorage, OBJECT_STORAGE } from "./object-storage.ts";
import { createValkeyClient, VALKEY_CLIENT, type ValkeyClient } from "./valkey.ts";

@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) => createApiDatabase(config.DATABASE_URL),
    },
    {
      provide: FIELD_ENCRYPTION,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) => FieldEncryption.fromConfig(config),
    },
    {
      provide: OBJECT_STORAGE,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) => createObjectStorage(config),
    },
    {
      provide: VALKEY_CLIENT,
      inject: [API_CONFIG],
      useFactory: async (config: ApiConfig) => {
        const client = createValkeyClient(config.VALKEY_URL);
        // Connect early so rate limiting works from the first request; if
        // Valkey is down, the API still starts and /health/ready reports it.
        await client?.connect().catch(() => undefined);
        return client;
      },
    },
  ],
  exports: [DATABASE, FIELD_ENCRYPTION, OBJECT_STORAGE, VALKEY_CLIENT],
})
export class InfraModule implements OnApplicationShutdown {
  private readonly db: OptionalDatabase;
  private readonly valkey: ValkeyClient;

  constructor(@Inject(DATABASE) db: OptionalDatabase, @Inject(VALKEY_CLIENT) valkey: ValkeyClient) {
    this.db = db;
    this.valkey = valkey;
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.db?.close(), this.valkey?.quit()]);
  }
}
