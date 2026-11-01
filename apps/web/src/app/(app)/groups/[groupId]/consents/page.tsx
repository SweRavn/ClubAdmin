// SPDX-License-Identifier: AGPL-3.0-only
// A group's consents (P1.8a): for its leaders, owners, club managers and
// registrars, who has consented to what (whom not to photograph before the
// cup). Members without consent first; protected members are counted and
// never named for those who may not see them.

import { enumKey } from "@clubadmin/i18n";
import { CONSENT_PURPOSES } from "@clubadmin/shared";
import { personLabel } from "@clubadmin/ui";
import { forbidden } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { getGroup, getGroupConsents } from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ groupId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("privacy.groupConsents") };
}

export default async function GroupConsentsPage({ params, searchParams }: Props) {
  const [{ groupId }, query] = await Promise.all([params, searchParams]);
  const purpose =
    typeof query.purpose === "string" &&
    (CONSENT_PURPOSES as readonly string[]).includes(query.purpose)
      ? query.purpose
      : null;
  const [t, group, consents] = await Promise.all([
    getTranslations(),
    getGroup(groupId),
    getGroupConsents(groupId, purpose),
  ]);
  if (!consents) forbidden();
  const rank = (item: (typeof consents.items)[number]) =>
    item.consents.filter((c) => c.status === "missing").length;
  const items = [...consents.items].sort((a, b) => rank(b) - rank(a));
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">
        {t("privacy.groupConsentsOf", { group: group.name })}
      </h1>
      <form method="get" className="flex items-end gap-2">
        <label className="block space-y-1 text-sm">
          <span>{t("privacy.purpose")}</span>
          <select
            name="purpose"
            defaultValue={purpose ?? ""}
            className="rounded-md border border-border bg-bg px-2 py-1"
          >
            <option value="">{t("privacy.allPurposes")}</option>
            {CONSENT_PURPOSES.map((p) => (
              <option key={p} value={p}>
                {t(enumKey("consentPurposes", p))}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="rounded-md border border-border px-3 py-1">
          {t("privacy.show")}
        </button>
      </form>
      <ul className="flex flex-wrap gap-4 text-sm" data-testid="consent-counts">
        {consents.counts.map((c) => (
          <li key={c.purpose}>
            <span className="font-medium">{t(enumKey("consentPurposes", c.purpose))}:</span>{" "}
            {t("privacy.countOf", { consented: c.consented, total: c.total })}
          </li>
        ))}
      </ul>
      <table className="w-full text-sm" data-testid="consent-table">
        <thead>
          <tr className="text-left">
            <th scope="col" className="py-2">
              {t("privacy.member")}
            </th>
            {consents.purposes.map((p) => (
              <th key={p} scope="col" className="py-2">
                {t(enumKey("consentPurposes", p))}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {items.map((item) => (
            <tr key={item.person.id}>
              <th scope="row" className="py-2 pr-3 text-left font-normal">
                {personLabel(item.person)}
              </th>
              {item.consents.map((c) => (
                <td key={c.purpose} className="py-2" data-status={c.status}>
                  {c.status === "given"
                    ? t("privacy.statusGiven")
                    : c.status === "missing"
                      ? t("privacy.statusMissing")
                      : t("privacy.statusNotApplicable")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
