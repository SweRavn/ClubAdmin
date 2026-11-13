// SPDX-License-Identifier: AGPL-3.0-only
// A chat message's ID is chosen by the app (P2.1, ADR 0047): a UUIDv7, so
// messages sort by when they were written and a resend from the outbox
// never posts the same message twice. Hermes has no Web Crypto, so the
// random bits come from expo-crypto.

import { getRandomBytes } from "expo-crypto";

let lastMs = 0;
let sequence = 0;

export function messageId(now: number = Date.now()): string {
  const bytes = getRandomBytes(16);
  // IDs made in the same millisecond stay in order (a 12-bit counter).
  if (now > lastMs) {
    lastMs = now;
    sequence = ((bytes[6] ?? 0) & 0x07) * 256 + (bytes[7] ?? 0);
  } else if (++sequence > 0x0fff) {
    lastMs++;
    sequence = 0;
  }
  const ms = lastMs;
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = 0x70 | ((sequence >> 8) & 0x0f);
  bytes[7] = sequence & 0xff;
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
