// SPDX-License-Identifier: AGPL-3.0-only
import { Skeleton } from "@clubadmin/ui";
import { getTranslations } from "next-intl/server";

export default async function Loading() {
  const t = await getTranslations();
  return (
    <div className="space-y-6">
      <div className="h-8 w-1/2 rounded-md bg-surface" />
      <Skeleton lines={6} label={t("common.loading")} />
    </div>
  );
}
