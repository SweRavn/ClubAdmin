// SPDX-License-Identifier: AGPL-3.0-only
// Audiences (ADR 0049) for other modules: announcements (P2.3) store theirs
// in the same list. Validated against the club's groups and roles; run in
// the caller's tenant transaction.

import type { Tx } from "@clubadmin/db";
import type { AudienceEntryInput } from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import * as repo from "./documents.repository.ts";

export type { AudienceEntryRow } from "./documents.repository.ts";

/** Stores a new audience (`audience_invalid` when a group or role is not the club's). */
export async function createAudience(
  tx: Tx,
  clubId: string,
  entries: readonly AudienceEntryInput[],
): Promise<string> {
  if (!(await repo.audienceEntriesValid(tx, clubId, entries))) {
    throw new DomainError("audience_invalid");
  }
  return repo.insertAudience(tx, clubId, entries);
}

/** Replaces an audience's entries. */
export async function replaceAudience(
  tx: Tx,
  clubId: string,
  audienceId: string,
  entries: readonly AudienceEntryInput[],
): Promise<void> {
  if (!(await repo.audienceEntriesValid(tx, clubId, entries))) {
    throw new DomainError("audience_invalid");
  }
  await repo.replaceAudience(tx, clubId, audienceId, entries);
}

/** The entries of audiences, with the groups' names. */
export const audienceEntries = repo.audienceEntries;
