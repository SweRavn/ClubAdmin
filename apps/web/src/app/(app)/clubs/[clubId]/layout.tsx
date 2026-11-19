// SPDX-License-Identifier: AGPL-3.0-only
// Every page of a club: the billing banner (P1.13) above the page when the
// club is read-only, a payment is overdue or the trial ends soon (nothing
// with billing off), and the breadcrumb trail (P2.7b).
import type { ReactNode } from "react";

import { BillingBanner } from "../../../../components/billing.tsx";
import { Breadcrumbs } from "../../../../components/breadcrumbs.tsx";
import { getClub, getEntitlements, getMyClubs } from "../../../../server/data.ts";

export default async function ClubLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ clubId: string }>;
}) {
  const { clubId } = await params;
  const [entitlements, mine, club] = await Promise.all([
    getEntitlements(clubId),
    getMyClubs(),
    getClub(clubId),
  ]);
  const permissions = mine.clubs.find((c) => c.club.id === clubId)?.permissions ?? [];
  return (
    <>
      {entitlements?.billingEnabled ? (
        <div className="mb-4">
          <BillingBanner clubId={clubId} entitlements={entitlements} permissions={permissions} />
        </div>
      ) : null}
      <Breadcrumbs club={{ id: club.id, name: club.name }} />
      {children}
    </>
  );
}
