// SPDX-License-Identifier: AGPL-3.0-only
// The only way the apps turn a person into text (ADR 0022). It takes a
// PersonSummary, which only the API's PersonPresenter produces: people the
// viewer may not see never reach a client. The web (packages/ui) and the
// mobile app build their PersonName components on it; the lint rule
// clubadmin/person-names-in-presenters forbids name fields elsewhere in
// both apps.

import type { PersonSummary } from "../auth/schemas.ts";

/**
 * Only API responses typed as PersonSummary have this exact shape; extra
 * keys (e.g. a whole person row) are refused at the type level.
 */
export type Exactly<T, U extends T> = U & Record<Exclude<keyof U, keyof T>, never>;

/** A person's name as plain text, for messages ("Logged in as {name}") and labels. */
export function personLabel<P extends PersonSummary>(person: Exactly<PersonSummary, P>): string {
  return person.displayName;
}
