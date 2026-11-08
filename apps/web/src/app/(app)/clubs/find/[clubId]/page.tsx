// SPDX-License-Identifier: AGPL-3.0-only
// The groups of a club that take applications for their waiting lists
// (P1.10b): from the club search for people outside the club (the publicly
// visible ones of a listed club), and from a group page for insiders (every
// group with a waiting list). Applying for myself or a child I act for; for
// someone outside the club this also asks to join the club. No people are
// shown, only the group, whether it is full and how many wait.
import { enumKey } from "@clubadmin/i18n";
import { personLabel } from "@clubadmin/ui";
import { getTranslations } from "next-intl/server";

import { ActionForm, buttonClass, inputClass } from "../../../../../components/action-form.tsx";
import { FormError } from "../../../../../components/form-error.tsx";
import { getMe, getMyWards, getOpenGroups } from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("waitlist.openGroups") };
}

export default async function OpenGroupsPage({ params, searchParams }: Props) {
  const [{ clubId }, query] = await Promise.all([params, searchParams]);
  const [t, me, wards, groups] = await Promise.all([
    getTranslations(),
    getMe(),
    getMyWards(),
    getOpenGroups(clubId),
  ]);
  const children = wards.wards.filter((w) => w.rights.includes("act_on_behalf"));
  const only = typeof query.group === "string" ? query.group : null;
  const items = only ? groups.items.filter((g) => g.id === only) : groups.items;

  return (
    <div className="space-y-6" data-testid="open-groups">
      <h1 className="text-2xl font-semibold">{t("waitlist.openGroups")}</h1>
      <FormError code={query.error} />
      {items.length === 0 ? (
        <p className="text-muted">{t("waitlist.noOpenGroups")}</p>
      ) : (
        <ul className="space-y-3">
          {items.map((g) => {
            // P1.14: a direct group with free places takes an application an owner admits.
            const place = g.admissionMode === "direct" && !g.full;
            return (
              <li
                key={g.id}
                className="space-y-2 rounded-lg border border-border bg-raised p-4"
                data-testid="open-group"
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <h2 className="text-lg font-semibold">{g.name}</h2>
                  {g.parentName ? <span className="text-sm text-muted">{g.parentName}</span> : null}
                  <span className="text-sm text-muted">{t(enumKey("kinds", g.kind))}</span>
                  <span className="ml-auto text-sm" data-testid="open-group-state">
                    {place
                      ? t("waitlist.directOpen")
                      : g.full
                        ? t("waitlist.full", { waiting: g.waiting })
                        : t("waitlist.notFull", { waiting: g.waiting })}
                  </span>
                </div>
                <p className="text-sm text-muted">
                  {[
                    g.birthYearFrom !== null
                      ? g.birthYearTo !== null && g.birthYearTo !== g.birthYearFrom
                        ? `${g.birthYearFrom}–${g.birthYearTo}`
                        : String(g.birthYearFrom)
                      : null,
                    g.genderCategory
                      ? t(enumKey("groupForm.genderCategories", g.genderCategory))
                      : null,
                    g.sport,
                    g.level,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                <details open={only !== null}>
                  <summary className="cursor-pointer text-accent">
                    {place ? t("waitlist.applyPlace") : t("waitlist.applyTitle")}
                  </summary>
                  <ActionForm action="apply-waitlist" className="mt-3 space-y-3">
                    <input type="hidden" name="groupId" value={g.id} />
                    <label className="block space-y-1">
                      <span>{t("waitlist.applyFor")}</span>
                      <select name="personId" className={inputClass} data-testid="apply-person">
                        {children.map((w) => (
                          <option key={w.person.id} value={w.person.id}>
                            {personLabel(w.person)}
                          </option>
                        ))}
                        <option value={me.personId}>
                          {t("findClub.yourself")} ({personLabel(me.person)})
                        </option>
                      </select>
                    </label>
                    <label className="block space-y-1">
                      <span>{t("waitlist.note")}</span>
                      <textarea name="note" maxLength={500} rows={3} className={inputClass} />
                    </label>
                    <button type="submit" className={buttonClass} data-testid={`apply-${g.id}`}>
                      {place ? t("waitlist.applyPlaceButton") : t("waitlist.apply")}
                    </button>
                  </ActionForm>
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
