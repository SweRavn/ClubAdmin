// SPDX-License-Identifier: AGPL-3.0-only
import { Inject, Module, type OnApplicationShutdown } from "@nestjs/common";

import { VALKEY_CLIENT, type ValkeyClient } from "../../platform/infra/valkey.ts";
import { AuthorizationModule } from "../authorization/index.ts";
import { RealtimeController } from "./realtime.controller.ts";
import { RealtimeBus, RealtimePublisher } from "./realtime.publisher.ts";
import { RealtimeTickets } from "./realtime.tickets.ts";

@Module({
  imports: [AuthorizationModule],
  controllers: [RealtimeController],
  providers: [
    {
      provide: RealtimeBus,
      inject: [VALKEY_CLIENT],
      useFactory: (valkey: ValkeyClient) => new RealtimeBus(valkey),
    },
    {
      provide: RealtimePublisher,
      inject: [RealtimeBus],
      useFactory: (bus: RealtimeBus) => new RealtimePublisher(bus),
    },
    {
      provide: RealtimeTickets,
      inject: [VALKEY_CLIENT],
      useFactory: (valkey: ValkeyClient) => new RealtimeTickets(valkey),
    },
  ],
  exports: [RealtimeBus, RealtimePublisher, RealtimeTickets],
})
export class RealtimeModule implements OnApplicationShutdown {
  private readonly bus: RealtimeBus;

  constructor(@Inject(RealtimeBus) bus: RealtimeBus) {
    this.bus = bus;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.bus.close();
  }
}
