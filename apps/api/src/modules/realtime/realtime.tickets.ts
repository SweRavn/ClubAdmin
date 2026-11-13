// SPDX-License-Identifier: AGPL-3.0-only
// Connection tickets (P2.1): a logged-in client asks the API for a ticket
// (through the web BFF, or the app with its bearer token) and opens the
// WebSocket with it. A ticket is random, used once and valid for a minute;
// only its hash is stored (Valkey, or memory without Valkey). Tokens never
// travel in WebSocket URLs.

import { createHash, randomBytes } from "node:crypto";

import { REALTIME_TICKET_TTL_SECONDS } from "@clubadmin/shared";
import type { Redis } from "ioredis";

/** Who the ticket was issued to (the logged-in person, not a ward acted for). */
export interface TicketHolder {
  personId: string;
  accountId: string | null;
  sessionId: string | null;
}

const hash = (ticket: string) => createHash("sha256").update(ticket).digest("base64url");
const key = (ticket: string) => `rt:ticket:${hash(ticket)}`;

export class RealtimeTickets {
  private readonly valkey: Redis | undefined;
  private readonly memory = new Map<string, { holder: TicketHolder; expires: number }>();

  constructor(valkey: Redis | undefined) {
    this.valkey = valkey;
  }

  async issue(holder: TicketHolder): Promise<{ ticket: string; expiresAt: Date }> {
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + REALTIME_TICKET_TTL_SECONDS * 1000);
    if (this.valkey) {
      await this.valkey.set(key(ticket), JSON.stringify(holder), "EX", REALTIME_TICKET_TTL_SECONDS);
    } else {
      this.prune();
      this.memory.set(key(ticket), { holder, expires: expiresAt.getTime() });
    }
    return { ticket, expiresAt };
  }

  /** The ticket's holder, or null; the ticket cannot be used again. */
  async consume(ticket: string): Promise<TicketHolder | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) return null;
    if (this.valkey) {
      const value = await this.valkey.getdel(key(ticket)).catch(() => null);
      return value ? (JSON.parse(value) as TicketHolder) : null;
    }
    const entry = this.memory.get(key(ticket));
    this.memory.delete(key(ticket));
    return entry && entry.expires > Date.now() ? entry.holder : null;
  }

  private prune(): void {
    const now = Date.now();
    for (const [k, v] of this.memory) if (v.expires <= now) this.memory.delete(k);
  }
}
