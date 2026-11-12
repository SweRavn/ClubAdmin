// SPDX-License-Identifier: AGPL-3.0-only
// The operator console (P1.13; club types P1.15 B): only for platform
// operators acting as operators with a second factor; everyone else gets the
// forbidden page. Club name and country only, never member data. Billing
// shows only with BILLING_ENABLED.
import { forbidden } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { getOpsClubTypes, getOpsSubscriptions } from "../../../server/data.ts";

export default async function OpsLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations();
  const [types, billing] = await Promise.all([
    getOpsClubTypes(),
    // Billing routes exist only with BILLING_ENABLED.
    getOpsSubscriptions("limit=1").catch(() => null),
  ]);
  if (!types) forbidden();
  return (
    <div className="space-y-6" data-testid="ops">
      <nav className="flex gap-4 border-b border-border pb-2 text-sm">
        <a href="/ops/club-types" className="font-medium underline">
          {t("clubTypes.title")}
        </a>
        {billing ? (
          <a href="/ops/billing" className="font-medium underline">
            {t("billing.ops.title")}
          </a>
        ) : null}
      </nav>
      <p className="text-sm text-muted">{t("billing.ops.noMemberData")}</p>
      {children}
    </div>
  );
}
