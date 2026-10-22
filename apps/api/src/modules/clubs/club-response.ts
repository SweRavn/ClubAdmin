// SPDX-License-Identifier: AGPL-3.0-only
import type { ClubResponse } from "@clubadmin/shared";

import type { Club } from "./clubs.service.ts";

export function toClubResponse(club: Club): ClubResponse {
  return {
    id: club.id,
    name: club.name,
    shortName: club.shortName,
    slug: club.slug,
    country: club.country,
    logo: club.logo,
    defaultLocale: club.defaultLocale,
    timeZone: club.timeZone,
    currency: club.currency,
    status: club.status,
    joinPolicy: club.joinPolicy,
  };
}
