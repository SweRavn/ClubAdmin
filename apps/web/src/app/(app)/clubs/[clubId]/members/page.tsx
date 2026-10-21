// SPDX-License-Identifier: AGPL-3.0-only
// The member register arrives in P1.2; the navigation entry already follows
// the club.members.read permission (GET /me/clubs).

import { EmptyState } from "@clubadmin/ui";
import { forbidden } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { getClub, getMyClubs } from "../../../../../server/data.ts";

type Params = { params: Promise<{ clubId: string }> };

export default async function MembersPage({ params }: Params) {
  const { clubId } = await params;
  const [t, club, mine] = await Promise.all([getTranslations(), getClub(clubId), getMyClubs()]);
  const permissions = mine.clubs.find((c) => c.club.id === club.id)?.permissions ?? [];
  if (!permissions.includes("club.members.read")) forbidden();
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t("members.title", { club: club.name })}</h1>
      <EmptyState title={t("nav.members")}>
        <p>{t("members.comingSoon")}</p>
      </EmptyState>
    </div>
  );
}
