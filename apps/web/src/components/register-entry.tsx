// SPDX-License-Identifier: AGPL-3.0-only
// One member of the register (P1.2), rendered by the server page and by the
// client list alike. Shows what the API returned for the viewer's access:
// the limited register has no birth date, status, phone or consents.

import type { RegisterMember } from "@clubadmin/shared";
import { PersonName, RoleBadge } from "@clubadmin/ui";

export interface RegisterTexts {
  protectedTooltip: string;
  /** "No. {number}" */
  memberNumber: string;
  /** "Born {date}" */
  born: string;
  /** "No consent for: {purposes}" */
  missingConsents: string;
  types: Record<string, string>;
  statuses: Record<string, string>;
  consents: Record<string, string>;
  other: string;
}

const fill = (template: string, name: string, value: string) =>
  template.replace(`{${name}}`, value);

export function RegisterEntry({
  member,
  clubId,
  texts,
}: {
  member: RegisterMember;
  clubId: string;
  texts: RegisterTexts;
}) {
  const status = member.membership?.status;
  return (
    <div
      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-1"
      data-person={member.person.id}
    >
      <span className="font-medium">
        <PersonName
          person={member.person}
          href={`/people/${member.person.id}?clubId=${clubId}`}
          protectedLabel={texts.protectedTooltip}
        />
      </span>
      <span className="text-sm text-muted">
        {fill(texts.memberNumber, "number", String(member.memberNumber))}
      </span>
      <RoleBadge label={texts.types[member.membershipType] ?? texts.other} />
      {status && status !== "active" ? (
        <RoleBadge tone="accent" label={texts.statuses[status] ?? texts.other} />
      ) : null}
      {member.birthDate ? (
        <span className="text-sm text-muted">{fill(texts.born, "date", member.birthDate)}</span>
      ) : null}
      {member.phone ? <span className="text-sm">{member.phone}</span> : null}
      {member.groups.length > 0 ? (
        <span className="text-sm">{member.groups.map((g) => g.name).join(", ")}</span>
      ) : null}
      {member.missingConsents?.length ? (
        <span className="text-sm text-muted">
          {fill(
            texts.missingConsents,
            "purposes",
            member.missingConsents.map((p) => texts.consents[p] ?? texts.other).join(", "),
          )}
        </span>
      ) : null}
    </div>
  );
}
