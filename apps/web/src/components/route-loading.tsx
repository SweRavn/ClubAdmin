// SPDX-License-Identifier: AGPL-3.0-only
// The skeleton shown while a page loads. Each section's loading.tsx uses it;
// the home page has none (P1.14): its content then arrives with the first
// paint instead of in a Suspense reveal that React 19.2 holds back for about
// 300 ms, which put its largest paint over the LCP budget.
import { Skeleton } from "@clubadmin/ui";
import { getTranslations } from "next-intl/server";

export async function RouteLoading() {
  const t = await getTranslations();
  return (
    <div className="space-y-6">
      <div className="h-8 w-1/2 rounded-md bg-surface" />
      <Skeleton lines={6} label={t("common.loading")} />
    </div>
  );
}
