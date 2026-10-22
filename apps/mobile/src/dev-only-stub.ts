// SPDX-License-Identifier: AGPL-3.0-only
// What the development-only modules (persona picker, development tokens)
// resolve to in preview and production bundles (metro.config.js).

export function PersonaPicker(): null {
  return null;
}

const unavailable = () => Promise.reject(new Error("DEV_AUTH is not part of this build"));
export const fetchPersonas = unavailable;
export const fetchDevTokens = unavailable;
