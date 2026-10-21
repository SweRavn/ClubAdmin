// SPDX-License-Identifier: AGPL-3.0-only
// The only way person names leave the API (CLAUDE.md rule 4, ADR 0022).
// P0.6 stub: shows the person's name with the protected-identity flag.
// P0.7 replaces it with the PersonVisibility service (full, with icon, or
// hidden, for the viewer and club in question).

import type { PersonSummary } from "@clubadmin/shared";

export interface PresentablePerson {
  id: string;
  givenName: string;
  familyName: string;
  protectedIdentity: boolean;
}

/** A person summary for `viewerPersonId`. */
export function presentPerson(_viewerPersonId: string, person: PresentablePerson): PersonSummary {
  return {
    id: person.id,
    displayName: `${person.givenName} ${person.familyName}`.trim(),
    givenName: person.givenName,
    familyName: person.familyName,
    protectedIdentity: person.protectedIdentity,
  };
}
