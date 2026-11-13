// SPDX-License-Identifier: AGPL-3.0-only
// A ticket to open the real-time connection (P2.1): logged-in people only;
// the WebSocket itself is the chat module's gateway.

import { REALTIME_PATH, type RealtimeTicket, RealtimeTicketSchema } from "@clubadmin/shared";
import { Controller, Inject } from "@nestjs/common";

import { API_CONFIG, type ApiConfig } from "../../config.ts";
import { Endpoint } from "../../platform/http/endpoint.ts";
import { ProblemError } from "../../platform/http/problem-error.ts";
import { CurrentAuthorization, type RequestAuthorization } from "../authorization/index.ts";
import { RealtimeTickets } from "./realtime.tickets.ts";

/** Tickets per account: a reconnecting client asks again, nothing more. */
const TICKET_LIMIT = { max: 30, timeWindowMs: 60_000 };

@Controller()
export class RealtimeController {
  private readonly tickets: RealtimeTickets;
  private readonly url: string;

  constructor(tickets: RealtimeTickets, @Inject(API_CONFIG) config: ApiConfig) {
    this.tickets = tickets;
    const base = new URL(config.PUBLIC_API_URL);
    base.protocol = base.protocol === "http:" ? "ws:" : "wss:";
    base.pathname = REALTIME_PATH;
    this.url = base.toString();
  }

  @Endpoint({
    method: "POST",
    path: "realtime/tickets",
    summary: "A single-use ticket to open the real-time connection (chat, P2.1)",
    tags: ["chat"],
    access: { authenticated: true },
    response: RealtimeTicketSchema,
    rateLimit: TICKET_LIMIT,
  })
  async ticket(@CurrentAuthorization() authz: RequestAuthorization): Promise<RealtimeTicket> {
    // The connection is the logged-in person's own, never a ward's (ADR 0047 rule 6).
    if (authz.actor.onBehalfOf) throw new ProblemError("forbidden", { detail: "on_behalf_of" });
    const { ticket, expiresAt } = await this.tickets.issue({
      personId: authz.principal.personId,
      accountId: authz.principal.accountId,
      sessionId: authz.principal.sessionId,
    });
    const url = new URL(this.url);
    url.searchParams.set("ticket", ticket);
    return { ticket, url: url.toString(), expiresAt: expiresAt.toISOString() };
  }
}
