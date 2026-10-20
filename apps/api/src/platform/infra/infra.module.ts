// SPDX-License-Identifier: AGPL-3.0-only
import { Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";

import { API_CONFIG, type ApiConfig } from "../../config.ts";
import { createDatabasePool, DATABASE_POOL, type DatabasePool } from "./database.ts";
import { createValkeyClient, VALKEY_CLIENT, type ValkeyClient } from "./valkey.ts";

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_POOL,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) => createDatabasePool(config.DATABASE_URL),
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
  exports: [DATABASE_POOL, VALKEY_CLIENT],
})
export class InfraModule implements OnApplicationShutdown {
  private readonly pool: DatabasePool;
  private readonly valkey: ValkeyClient;

  constructor(
    @Inject(DATABASE_POOL) pool: DatabasePool,
    @Inject(VALKEY_CLIENT) valkey: ValkeyClient,
  ) {
    this.pool = pool;
    this.valkey = valkey;
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.pool?.end(), this.valkey?.quit()]);
  }
}
