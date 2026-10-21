// SPDX-License-Identifier: AGPL-3.0-only
// One row of a group's roster, rendered by the server page and by the
// client list alike.

import type { GroupFunction, PersonSummary } from "@clubadmin/shared";
import { PersonName, RoleBadge } from "@clubadmin/ui";

export interface RosterTexts {
  protectedTooltip: string;
  functions: Record<GroupFunction, string>;
}

export function RosterEntry({
  entry,
  clubId,
  texts,
}: {
  entry: { person: PersonSummary; functions: GroupFunction[] };
  clubId: string;
  texts: RosterTexts;
}) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <PersonName
        person={entry.person}
        href={`/people/${entry.person.id}?clubId=${clubId}`}
        protectedLabel={texts.protectedTooltip}
      />
      {entry.functions.map((fn) => (
        <RoleBadge
          key={fn}
          tone={fn === "member" ? "neutral" : "accent"}
          label={texts.functions[fn]}
        />
      ))}
    </span>
  );
}
