// SPDX-License-Identifier: AGPL-3.0-only
// The club a person last looked at, per person (not per browser), so the
// app opens there on every device. Only an ID is stored.

import { valkey } from "./valkey.ts";

const key = (personId: string) => `web:last-club:${personId}`;
const ONE_YEAR_SECONDS = 365 * 24 * 3600;

export async function lastClub(personId: string): Promise<string | null> {
  try {
    return await valkey().get(key(personId));
  } catch {
    return null;
  }
}

export async function rememberClub(personId: string, clubId: string): Promise<void> {
  await valkey().set(key(personId), clubId, "EX", ONE_YEAR_SECONDS);
}
