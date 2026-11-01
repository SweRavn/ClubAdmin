// SPDX-License-Identifier: AGPL-3.0-only
// What a person still owes a club (P1.8a, ADR 0041): leaving the club (and,
// in P1.8b, deleting the account) is refused while invoices from the club
// are neither paid nor written off. No module issues invoices to members
// yet: the finance module (member fees, Phase 3) registers a provider.
// Providers report counts and whom to contact (a role), never amounts,
// invoice texts or names.

import type { Tx } from "@clubadmin/db";
import type { ClubRole } from "@clubadmin/shared";

export interface OutstandingObligation {
  /** How many invoices are open. */
  count: number;
  /** The role that settles or writes them off (the treasurer, usually). */
  contactRole: ClubRole;
}

export interface OutstandingObligationsProvider {
  forPerson(tx: Tx, clubId: string, personId: string): Promise<OutstandingObligation | null>;
}

/** Nest token of the registered providers (an array). */
export const OUTSTANDING_OBLIGATIONS = Symbol("OUTSTANDING_OBLIGATIONS");
