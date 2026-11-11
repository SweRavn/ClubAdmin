// SPDX-License-Identifier: AGPL-3.0-only
// How roles work (P1.15 A2): permission → role → person, in the club or in
// a group, in plain language, linked from every role screen.
import { getTranslations } from "next-intl/server";

export async function generateMetadata() {
  return { title: (await getTranslations())("rolesAdmin.helpTitle") };
}

export default async function RolesHelpPage() {
  const t = await getTranslations();
  const steps = [
    ["helpPermission", "helpPermissionText"],
    ["helpRole", "helpRoleText"],
    ["helpPerson", "helpPersonText"],
  ] as const;
  return (
    <article className="max-w-2xl space-y-4" data-testid="roles-help">
      <h1 className="text-2xl font-semibold">{t("rolesAdmin.helpTitle")}</h1>
      <p>{t("rolesAdmin.helpIntro")}</p>
      <ol
        className="flex flex-col gap-2 sm:flex-row sm:items-stretch"
        aria-label={t("rolesAdmin.helpTitle")}
      >
        {steps.map(([title, text], i) => (
          <li key={title} className="flex flex-1 items-center gap-2">
            <div className="flex-1 rounded-lg border border-border bg-raised p-3">
              <p className="font-semibold">{t(`rolesAdmin.${title}`)}</p>
              <p className="text-sm">{t(`rolesAdmin.${text}`)}</p>
            </div>
            {i < steps.length - 1 ? (
              <span aria-hidden="true" className="text-xl text-muted">
                →
              </span>
            ) : null}
          </li>
        ))}
      </ol>
      <p>{t("rolesAdmin.helpGroups")}</p>
      <p>{t("rolesAdmin.helpManagers")}</p>
      <p>{t("rolesAdmin.helpSelf")}</p>
      <p>{t("rolesAdmin.helpEffect")}</p>
    </article>
  );
}
