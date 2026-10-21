// SPDX-License-Identifier: AGPL-3.0-only
// UUID version 7 (RFC 9562): 48-bit Unix milliseconds + random bits.
// Time-ordered, so it indexes well, and not guessable (ADR 0020).
// The database generates row IDs with Postgres 18's uuidv7(); this is for IDs
// created in application code (e.g. request IDs).

let lastMs = 0;
let sequence = 0;

export function uuidv7(now: number = Date.now()): string {
  // Web Crypto: available in Node.js and in edge runtimes (the web app's middleware).
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  // Keep IDs generated within the same millisecond ordered: use a 12-bit
  // counter in rand_a, seeded randomly each new millisecond.
  if (now > lastMs) {
    lastMs = now;
    sequence = ((bytes[6] ?? 0) & 0x07) * 256 + (bytes[7] ?? 0);
  } else {
    sequence++;
    if (sequence > 0x0fff) {
      // Counter exhausted (or the clock went backwards): borrow the next millisecond.
      lastMs++;
      sequence = 0;
    }
  }
  const ms = lastMs;
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = 0x70 | ((sequence >> 8) & 0x0f); // version 7
  bytes[7] = sequence & 0xff;
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f); // variant 10
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isUuid = (value: string) => UUID_PATTERN.test(value);
