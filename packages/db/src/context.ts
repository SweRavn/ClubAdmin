// SPDX-License-Identifier: AGPL-3.0-only
// Who is acting, recorded in transaction-local settings for row-level
// security, record history and audit events.

import { isUuid } from "@clubadmin/shared";

/** ADR 0017 actor kinds. `anonymous` is for not-logged-in flows such as sign-up. */
export type ActorKind = "person" | "operator" | "anonymous" | "system_job" | "migration";

export interface ActorContext {
  actorKind: "person" | "operator" | "anonymous";
  /** The person acting (required for person and operator). */
  personId?: string | null;
  /** A guardian acting for a child: the child's person ID (ADR 0006). */
  onBehalfOf?: string | null;
  requestId?: string | null;
  /** Salted hash of the client IP, for audit events. Never the IP itself. */
  ipHash?: string | null;
}

export interface TenantContext extends ActorContext {
  clubId: string;
}

export interface Settings {
  "app.club_id": string;
  "app.person_id": string;
  "app.on_behalf_of": string;
  "app.request_id": string;
  "app.actor_kind": ActorKind;
  "app.ip_hash": string;
}

function requireUuid(name: string, value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (!isUuid(value)) throw new Error(`${name} must be a UUID`);
  return value;
}

/** Builds the settings for a transaction, validating IDs. */
export function settingsFor(
  actor: { actorKind: ActorKind } & Omit<ActorContext, "actorKind">,
  clubId?: string | null,
): Settings {
  if ((actor.actorKind === "person" || actor.actorKind === "operator") && !actor.personId) {
    throw new Error(`actorKind "${actor.actorKind}" requires personId`);
  }
  if (actor.onBehalfOf && !actor.personId) throw new Error("onBehalfOf requires personId");
  return {
    "app.club_id": requireUuid("clubId", clubId),
    "app.person_id": requireUuid("personId", actor.personId),
    "app.on_behalf_of": requireUuid("onBehalfOf", actor.onBehalfOf),
    "app.request_id": actor.requestId ?? "",
    "app.actor_kind": actor.actorKind,
    "app.ip_hash": actor.ipHash ?? "",
  };
}
