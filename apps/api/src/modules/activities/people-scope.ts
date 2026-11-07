// SPDX-License-Identifier: AGPL-3.0-only
// Whose schedule an actor sees and for whom they answer (P1.4, P1.5), as
// functions of an Actor so that calendar feeds and answer links (P1.11),
// which act as their owner without a request, apply the same rules.

import type { Actor } from "../authorization/index.ts";

/** Me, and the wards whose schedule I may see (none when acting on behalf). */
export function schedulePeopleOf(actor: Actor): string[] {
  return [
    actor.personId,
    ...actor.relationships.wards
      .filter((w) => w.rights.includes("view_schedule"))
      .map((w) => w.personId),
  ].filter((id, i, all) => all.indexOf(id) === i);
}

/**
 * Whom the actor may answer for: themselves (the ward when acting on their
 * behalf), and otherwise the wards whose guardian holds sign_up (full
 * guardians hold every right).
 */
export function respondablePeopleOf(actor: Actor): string[] {
  if (actor.onBehalfOf) return [actor.personId];
  return [
    actor.personId,
    ...actor.relationships.wards
      .filter((w) => w.rights.includes("sign_up") || actor.isFullGuardianOf(w.personId))
      .map((w) => w.personId),
  ].filter((id, i, all) => all.indexOf(id) === i);
}
