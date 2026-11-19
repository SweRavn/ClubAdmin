// SPDX-License-Identifier: AGPL-3.0-only
"use client";
// Switches the current club (from GET /me/clubs). The web app remembers the
// last club per user.

import { Menu } from "./menu.tsx";

export interface ClubSwitcherProps {
  clubs: readonly { id: string; name: string; href: string }[];
  currentId: string | null;
  /** Accessible name, e.g. "Club: IK Norrbacka". */
  label: string;
  /** Shown when there is no current club. */
  placeholder: string;
  /** A visible label before the club's name (P2.7b), e.g. "Förening:". */
  prefix?: string;
  /**
   * The first entry, back to the pages about the person across clubs
   * (P2.7c): its label ("Alla föreningar") and where it goes. Current when no
   * club is.
   */
  all?: { label: string; href: string };
}

export function ClubSwitcher({
  clubs,
  currentId,
  label,
  placeholder,
  prefix,
  all,
}: ClubSwitcherProps) {
  const current = clubs.find((c) => c.id === currentId);
  return (
    <Menu
      label={label}
      testId="club-switcher"
      trigger={
        <span className="truncate">
          {prefix ? <span className="text-muted">{prefix} </span> : null}
          <span data-testid="club-switcher-current">{current?.name ?? placeholder}</span>
        </span>
      }
      items={[
        ...(all
          ? [
              {
                kind: "link" as const,
                key: "all",
                label: all.label,
                href: all.href,
                current: currentId === null,
              },
            ]
          : []),
        ...clubs.map((club) => ({
          kind: "link" as const,
          key: club.id,
          label: club.name,
          href: club.href,
          current: club.id === currentId,
        })),
      ]}
    />
  );
}
