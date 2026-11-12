// SPDX-License-Identifier: AGPL-3.0-only
"use client";
// The invitation form's group matrix (P1.15 A4): the club's active groups the
// inviter may invite to, their own first, filtered by name and kind, with a
// group role per ticked row (the participant role by default). Filtering
// only hides rows; without JavaScript every row shows and the form still
// works (ticked rows post `groupIds`, each with its `role-<groupId>`).
import { useState } from "react";

// As inputClass in action-form.tsx (a server module, not importable here).
const inputClass = "w-full rounded-md border border-border bg-bg px-3 py-2";

export interface PickerGroup {
  id: string;
  name: string;
  kind: string;
  kindLabel: string;
  own: boolean;
  roles: { id: string; label: string }[];
}

export function InvitationGroupPicker({
  groups,
  kinds,
  labels,
}: {
  groups: PickerGroup[];
  kinds: { value: string; label: string }[];
  labels: {
    legend: string;
    hint: string;
    filter: string;
    allKinds: string;
    role: string;
    own: string;
    none: string;
    chosen: string;
  };
}) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const needle = query.trim().toLocaleLowerCase();
  const shown = (g: PickerGroup) =>
    chosen.has(g.id) ||
    ((needle === "" || g.name.toLocaleLowerCase().includes(needle)) &&
      (kind === "" || g.kind === kind));
  return (
    <fieldset className="space-y-2 sm:col-span-2" data-testid="invitation-groups">
      <legend className="text-sm font-medium">{labels.legend}</legend>
      <p className="text-sm text-muted">{labels.hint}</p>
      {groups.length === 0 ? (
        <p className="text-sm text-muted">{labels.none}</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <input
              type="search"
              aria-label={labels.filter}
              placeholder={labels.filter}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className={`${inputClass} max-w-xs`}
              data-testid="invitation-groups-filter"
            />
            <select
              aria-label={labels.allKinds}
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              className={`${inputClass} max-w-xs`}
            >
              <option value="">{labels.allKinds}</option>
              {kinds.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
            {chosen.size > 0 ? (
              <span className="self-center text-sm" aria-live="polite">
                {labels.chosen.replace("#", String(chosen.size))}
              </span>
            ) : null}
          </div>
          <ul className="max-h-96 divide-y divide-border overflow-y-auto rounded-md border border-border">
            {groups.map((g) => (
              <li
                key={g.id}
                hidden={!shown(g)}
                className="flex flex-wrap items-center gap-3 px-3 py-2"
                data-testid="invitation-group"
              >
                <label className="flex flex-1 items-center gap-2">
                  <input
                    type="checkbox"
                    name="groupIds"
                    value={g.id}
                    checked={chosen.has(g.id)}
                    onChange={(e) => {
                      const next = new Set(chosen);
                      if (e.target.checked) next.add(g.id);
                      else next.delete(g.id);
                      setChosen(next);
                    }}
                  />
                  <span>{g.name}</span>
                  <span className="text-xs text-muted">{g.kindLabel}</span>
                  {g.own ? (
                    <span className="rounded bg-accent-soft px-1 text-xs">{labels.own}</span>
                  ) : null}
                </label>
                {g.roles.length > 1 ? (
                  <select
                    name={`role-${g.id}`}
                    aria-label={`${labels.role}: ${g.name}`}
                    className={`${inputClass} w-auto`}
                    defaultValue={g.roles[0]?.id}
                    data-testid={`invitation-role-${g.id}`}
                  >
                    {g.roles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-sm text-muted">{g.roles[0]?.label}</span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </fieldset>
  );
}
