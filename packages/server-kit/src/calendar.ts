// SPDX-License-Identifier: AGPL-3.0-only
// Answer links of calendar feeds (P1.11, ADR 0044): base64url of the feed,
// activity and person IDs, the status and an HMAC-SHA256 truncated to 128
// bits (65 bytes, 87 characters: route parameters are limited to 100). The
// key is CALENDAR_TOKEN_KEY; rotating it ends every link.

import { createHmac, timingSafeEqual } from "node:crypto";

export type CalendarAnswerStatus = "attending" | "not_attending";

const compact = (uuid: string) => Buffer.from(uuid.replace(/-/g, ""), "hex");
const expand = (bytes: Buffer) => {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const sign = (key: string, payload: Buffer) =>
  createHmac("sha256", key).update("calendar-answer:").update(payload).digest().subarray(0, 16);

export function calendarAnswerToken(
  key: string,
  link: { feedId: string; activityId: string; personId: string; status: CalendarAnswerStatus },
): string {
  const payload = Buffer.concat([
    compact(link.feedId),
    compact(link.activityId),
    compact(link.personId),
    Buffer.from([link.status === "attending" ? 1 : 0]),
  ]);
  return Buffer.concat([payload, sign(key, payload)]).toString("base64url");
}

/** The link's parts if the signature holds, else null. */
export function parseCalendarAnswerToken(
  key: string,
  token: string,
): { feedId: string; activityId: string; personId: string; status: CalendarAnswerStatus } | null {
  const raw = Buffer.from(token, "base64url");
  if (raw.length !== 65 || raw[48]! > 1) return null;
  const payload = raw.subarray(0, 49);
  if (!timingSafeEqual(raw.subarray(49), sign(key, payload))) return null;
  return {
    feedId: expand(payload.subarray(0, 16)),
    activityId: expand(payload.subarray(16, 32)),
    personId: expand(payload.subarray(32, 48)),
    status: raw[48] === 1 ? "attending" : "not_attending",
  };
}
