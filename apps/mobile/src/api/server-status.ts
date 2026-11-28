// SPDX-License-Identifier: AGPL-3.0-only
// Whether ClubAdmin's server answers, apart from whether the phone is online
// (NetInfo): with a network but no answer (the server is down, a proxy or a
// firewall blocks it, DNS fails) the app says that the server does not
// answer, not that the phone is offline. Set by every query and mutation:
// a request that never got an answer (or a gateway's 502–504) marks the
// server unreachable, any answer marks it reachable again.

import { ApiError } from "@clubadmin/api-client";
import { useSyncExternalStore } from "react";

let reachable = true;
const listeners = new Set<() => void>();

function set(value: boolean) {
  if (reachable === value) return;
  reachable = value;
  for (const listener of listeners) listener();
}

/** A request that got no answer from ClubAdmin: no response at all, or a gateway in front of it. */
export function isUnreachable(error: unknown): boolean {
  if (error instanceof ApiError) return error.status >= 502 && error.status <= 504;
  // React Native's fetch: TypeError("Network request failed"); an aborted (timed-out) request.
  return error instanceof TypeError || (error instanceof Error && error.name === "AbortError");
}

/** After a request: an answer (even an error answer) means the server is there. */
export function noteResult(error: unknown): void {
  set(error === null ? true : !isUnreachable(error));
}

export function isServerReachable(): boolean {
  return reachable;
}

export function useServerReachable(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => reachable,
  );
}
