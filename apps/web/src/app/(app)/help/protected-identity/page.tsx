// SPDX-License-Identifier: AGPL-3.0-only
// What the crossed-out camera means (P1.12, ADR 0022): a short, translated
// explanation for leaders and members, linked from the protected notices.
import { ProtectedBadge } from "@clubadmin/ui";
import { getTranslations } from "next-intl/server";

export async function generateMetadata() {
  return { title: (await getTranslations())("protection.helpTitle") };
}

export default async function ProtectedIdentityHelpPage() {
  const t = await getTranslations();
  return (
    <article className="max-w-2xl space-y-3" data-testid="protected-identity-help">
      <h1 className="flex items-center gap-2 text-2xl font-semibold">
        <ProtectedBadge label={t("protected.tooltip")} />
        {t("protection.helpTitle")}
      </h1>
      <p>{t("protection.helpWhat")}</p>
      <p className="font-medium">{t("protection.helpRules")}</p>
      <p>{t("protection.helpLeaders")}</p>
      <p>{t("protection.helpView")}</p>
    </article>
  );
}
