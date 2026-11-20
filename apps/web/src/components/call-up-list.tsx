// SPDX-License-Identifier: AGPL-3.0-only
// Who is called up, chosen when an activity or event is created (P2.7e):
// the group's players, all ticked; untick those who are not called up. The
// form sends who was offered (`callUpCandidate`) and who is ticked
// (`callUp`); the action sends those left out.
import type { PersonSummary } from "@clubadmin/shared";
import { PersonName } from "@clubadmin/ui";
import { getTranslations } from "next-intl/server";

export async function CallUpList({
  people,
  legend,
  ticked,
}: {
  people: readonly PersonSummary[];
  legend?: string | undefined;
  /** Who stays ticked (a kept draft); otherwise everyone. */
  ticked?: ReadonlySet<string> | null | undefined;
}) {
  if (people.length === 0) return null;
  const t = await getTranslations();
  return (
    <details open className="space-y-2" data-testid="call-up-list">
      <summary className="cursor-pointer font-medium">
        {legend ?? t("callUp.title")}{" "}
        <span className="text-sm font-normal text-muted">
          {t("callUp.count", { count: people.length })}
        </span>
      </summary>
      <p className="text-sm text-muted">{t("callUp.hint")}</p>
      <ul className="grid gap-1 sm:grid-cols-2">
        {people.map((p) => (
          <li key={p.id}>
            <input type="hidden" name="callUpCandidate" value={p.id} />
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                name="callUp"
                value={p.id}
                defaultChecked={ticked ? ticked.has(p.id) : true}
                className="h-5 w-5"
                data-testid="call-up"
              />
              <PersonName person={p} protectedLabel={t("protected.tooltip")} />
            </label>
          </li>
        ))}
      </ul>
    </details>
  );
}
