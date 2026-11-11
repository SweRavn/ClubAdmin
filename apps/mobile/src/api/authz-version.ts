// SPDX-License-Identifier: AGPL-3.0-only
// The caller's authorization version (P1.15 A2): every API response carries
// x-authz-version; when it changes, what the person may do changed (a role,
// its permissions, a membership), so the app refetches what it shows and
// drops cached screens the person may no longer see.

let last: string | null = null;
const listeners = new Set<() => void>();

/** Notes a response's version; a change after the first one tells the listeners. */
export function noteAuthzVersion(version: string | null): void {
  if (!version) return;
  if (last !== null && last !== version) for (const listener of listeners) listener();
  last = version;
}

export function onAuthzChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A new login starts without a known version. */
export function resetAuthzVersion(): void {
  last = null;
}
