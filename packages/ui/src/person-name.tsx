// SPDX-License-Identifier: AGPL-3.0-only
// The only way the web app shows a person's name (ADR 0022). It takes a
// PersonSummary, which only the API's PersonPresenter produces: people the
// viewer may not see never reach the page, and protected people carry the
// flag that shows the icon. The lint rule clubadmin/person-names-in-presenters
// forbids name fields everywhere else in apps/web and packages/ui.

import type { PersonSummary } from "@clubadmin/shared";
import type { ReactNode } from "react";

import { ProtectedBadge } from "./protected-badge.tsx";

/**
 * Only API responses parsed with the shared schemas have this exact shape;
 * extra keys (e.g. a whole person row) are refused at the type level.
 */
type Exactly<T, U extends T> = U & Record<Exclude<keyof U, keyof T>, never>;

/** A person's name as plain text, for messages ("Logged in as {name}"). */
export function personLabel<P extends PersonSummary>(person: Exactly<PersonSummary, P>): string {
  return person.displayName;
}

export interface PersonNameProps<P extends PersonSummary> {
  person: Exactly<PersonSummary, P>;
  /** Link to the person's profile. */
  href?: string;
  /** The translated protected-identity tooltip; the icon shows when the person is protected. */
  protectedLabel: string;
  children?: ReactNode;
}

export function PersonName<P extends PersonSummary>({
  person,
  href,
  protectedLabel,
  children,
}: PersonNameProps<P>) {
  const name = person.displayName;
  return (
    <span className="inline-flex items-center gap-1.5" data-person-id={person.id}>
      {href ? (
        <a href={href} className="font-medium text-accent underline-offset-2 hover:underline">
          {name}
        </a>
      ) : (
        <span className="font-medium">{name}</span>
      )}
      {person.protected ? <ProtectedBadge label={protectedLabel} /> : null}
      {children}
    </span>
  );
}
