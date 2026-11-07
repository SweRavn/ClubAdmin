// SPDX-License-Identifier: AGPL-3.0-only
// How a calendar feed or answer link names a person of the owner's family
// (P1.11, decision 8): the first name, or initials for a protected person.
// Applied to PersonSummary rows from PersonPresenter only (ADR 0022).

import type { PersonSummary } from "@clubadmin/shared";

export const shownName = (p: PersonSummary): string =>
  p.protected
    ? `${p.givenName.charAt(0)}.${p.familyName ? ` ${p.familyName.charAt(0)}.` : ""}`
    : p.givenName;
