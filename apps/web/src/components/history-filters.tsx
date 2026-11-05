// SPDX-License-Identifier: AGPL-3.0-only
// Filters of the club-wide changes and the audit log (P1.9): a plain GET
// form (works without JavaScript). The person picker searches the member
// register, so it offers only people the viewer may see; a second submit
// picks one of the matches.

import { isUuid } from "@clubadmin/shared";
import { personLabel } from "@clubadmin/ui";
import { getTranslations } from "next-intl/server";

import { getRegister } from "../server/data.ts";
import { buttonClass, inputClass } from "./action-form.tsx";

export type Query = Record<string, string | string[] | undefined>;

export const stringOf = (value: string | string[] | undefined, max = 100): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The period as API instants (whole days, UTC), or nothing. */
export function periodOf(query: Query): { from?: string; to?: string } {
  const from = stringOf(query.from);
  const to = stringOf(query.to);
  return {
    ...(DATE.test(from) ? { from: `${from}T00:00:00Z` } : {}),
    ...(DATE.test(to)
      ? { to: new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString() }
      : {}),
  };
}

export const actorOf = (query: Query): string | null => {
  const id = stringOf(query.actorId);
  return isUuid(id) ? id : null;
};

export async function HistoryFilters({
  clubId,
  query,
  select,
}: {
  clubId: string;
  query: Query;
  /** The first filter: kind of record or category, with its options. */
  select: { name: string; label: string; options: { value: string; label: string }[] };
}) {
  const t = await getTranslations();
  const actorQ = stringOf(query.actorQ);
  const matches =
    actorQ.length >= 2
      ? (await getRegister(clubId, new URLSearchParams({ q: actorQ, limit: "10" }).toString()))
          .items
      : [];
  const actorId = actorOf(query);
  const selected = stringOf(query[select.name]);
  return (
    <form
      method="get"
      className="grid gap-3 rounded-lg border border-border bg-raised p-4 sm:grid-cols-2"
      data-testid="history-filters"
    >
      <label className="space-y-1 text-sm">
        <span>{select.label}</span>
        <select name={select.name} defaultValue={selected} className={inputClass}>
          <option value="">{t("history.filterAll")}</option>
          {select.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <div className="space-y-1 text-sm">
        <label className="block space-y-1">
          <span>{t("history.filterActor")}</span>
          <input name="actorQ" defaultValue={actorQ} className={inputClass} />
        </label>
        {matches.length > 0 ? (
          <select name="actorId" defaultValue={actorId ?? ""} className={inputClass}>
            <option value="">{t("history.filterAll")}</option>
            {matches.map((m) => (
              <option key={m.person.id} value={m.person.id}>
                {personLabel(m.person)}
              </option>
            ))}
          </select>
        ) : actorId ? (
          <input type="hidden" name="actorId" value={actorId} />
        ) : null}
      </div>
      <label className="space-y-1 text-sm">
        <span>{t("history.filterFrom")}</span>
        <input type="date" name="from" defaultValue={stringOf(query.from)} className={inputClass} />
      </label>
      <label className="space-y-1 text-sm">
        <span>{t("history.filterTo")}</span>
        <input type="date" name="to" defaultValue={stringOf(query.to)} className={inputClass} />
      </label>
      <div>
        <button type="submit" className={buttonClass}>
          {t("history.filter")}
        </button>
      </div>
    </form>
  );
}
