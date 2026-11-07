// SPDX-License-Identifier: AGPL-3.0-only
// The operator console (P1.13, the first operator pages): only for platform
// operators acting as operators with a second factor; everyone else gets the
// forbidden page. Club name and country only, never member data.
import { forbidden } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { getOpsSubscriptions } from "../../../server/data.ts";

export default async function OpsLayout({ children }: { children: ReactNode }) {
  const [t, probe] = await Promise.all([getTranslations(), getOpsSubscriptions("limit=1")]);
  if (!probe) forbidden();
  return (
    <div className="space-y-6" data-testid="ops">
      <nav className="flex gap-4 border-b border-border pb-2 text-sm">
        <a href="/ops/billing" className="font-medium underline">
          {t("billing.ops.title")}
        </a>
      </nav>
      <p className="text-sm text-muted">{t("billing.ops.noMemberData")}</p>
      {children}
    </div>
  );
}
