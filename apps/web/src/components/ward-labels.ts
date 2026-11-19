// SPDX-License-Identifier: AGPL-3.0-only
// The "Viewing as" menu's entries (P2.7b): one per person, and people with
// the same name told apart by what the guardian already sees: the birth
// year, else their clubs, else marked as a possible duplicate.
import { personLabel, type PersonSummary } from "@clubadmin/shared";

interface Ward {
  person: PersonSummary;
  birthDate?: string | null | undefined;
  clubs?: readonly { name: string }[] | undefined;
}

export interface WardEntry {
  id: string;
  label: string;
}

export function wardEntries(
  wards: readonly Ward[],
  texts: { noClub: string; possibleDuplicate: string },
): WardEntry[] {
  const unique = [...new Map(wards.map((w) => [w.person.id, w])).values()];
  const names = unique.map((w) => personLabel(w.person));
  const distinct = (values: string[]) => new Set(values).size === values.length;
  return unique.map((w, i) => {
    const name = names[i]!;
    const same = unique.filter((_, j) => names[j] === name);
    if (same.length === 1) return { id: w.person.id, label: name };
    const year = (x: Ward) => x.birthDate?.slice(0, 4) ?? "";
    const clubs = (x: Ward) =>
      x.clubs && x.clubs.length > 0 ? x.clubs.map((c) => c.name).join(", ") : texts.noClub;
    const years = same.map(year);
    if (years.every(Boolean) && distinct(years))
      return { id: w.person.id, label: `${name} (${year(w)})` };
    const clubNames = same.map(clubs);
    if (distinct(clubNames)) return { id: w.person.id, label: `${name} (${clubs(w)})` };
    return { id: w.person.id, label: `${name} (${texts.possibleDuplicate})` };
  });
}
