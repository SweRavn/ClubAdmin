// SPDX-License-Identifier: AGPL-3.0-only
// The adult decision (P1.3): at the adult age the young person chooses, for
// each guardian, whether they keep access. Explained in plain words; the
// decision is theirs alone and cannot be changed here afterwards.

import { enumKey } from "@clubadmin/i18n";
import { PersonName, RoleBadge } from "@clubadmin/ui";
import { getTranslations } from "next-intl/server";

import {
  ActionForm,
  buttonClass,
  secondaryButtonClass,
} from "../../../../../components/action-form.tsx";
import { FormError, Notice } from "../../../../../components/form-error.tsx";
import { getAdultGuardians } from "../../../../../server/data.ts";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata() {
  return { title: (await getTranslations())("family.adult.title") };
}

export default async function AdultPage({ searchParams }: Props) {
  const [t, list, query] = await Promise.all([
    getTranslations(),
    getAdultGuardians(),
    searchParams,
  ]);
  return (
    <div className="space-y-6" data-testid="adult-decision">
      <h1 className="text-2xl font-semibold">{t("family.adult.title")}</h1>
      <FormError code={query.error} />
      {query.decided ? <Notice>{t("family.adult.saved")}</Notice> : null}
      <p>{t("family.adult.intro")}</p>
      <ul className="list-inside list-disc text-sm">
        <li>{t("family.adult.keepMeans")}</li>
        <li>{t("family.adult.endMeans")}</li>
        <li>{t("family.adult.later")}</li>
      </ul>
      {list.guardians.length === 0 ? (
        <p className="text-muted">{t("family.adult.none")}</p>
      ) : (
        <ul className="divide-y divide-border">
          {list.guardians.map((g) => (
            <li
              key={g.guardianshipId}
              className="flex flex-wrap items-center gap-3 py-3"
              data-testid="adult-guardian"
            >
              <PersonName person={g.person} protectedLabel={t("protected.tooltip")} />
              <RoleBadge label={t(enumKey("guardianKinds", g.kind))} />
              {g.decision === "kept" ? (
                <RoleBadge label={t("family.adult.kept")} tone="accent" />
              ) : (
                <>
                  <ActionForm action="adult-decision">
                    <input type="hidden" name="guardianshipId" value={g.guardianshipId} />
                    <input type="hidden" name="decision" value="keep" />
                    <button type="submit" className={buttonClass} data-testid="adult-keep">
                      {t("family.adult.keep")}
                    </button>
                  </ActionForm>
                  <ActionForm action="adult-decision">
                    <input type="hidden" name="guardianshipId" value={g.guardianshipId} />
                    <input type="hidden" name="decision" value="end" />
                    <button type="submit" className={secondaryButtonClass} data-testid="adult-end">
                      {t("family.adult.end")}
                    </button>
                  </ActionForm>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
