// SPDX-License-Identifier: AGPL-3.0-only
// Fixed-window rate limit in Valkey for /auth/* (login, callback, logout).
// Fails open if Valkey is unreachable: logging in is then still possible.

import { valkey } from "./valkey.ts";

export async function allowAuthRequest(ip: string, max: number): Promise<boolean> {
  const key = `bff:rate:auth:${ip}:${Math.floor(Date.now() / 60_000)}`;
  try {
    const count = await valkey().multi().incr(key).expire(key, 120).exec();
    const value = Number(count?.[0]?.[1] ?? 0);
    return value <= max;
  } catch {
    return true;
  }
}

/** Client IP as Caddy reports it (X-Forwarded-For, first hop). */
export function clientIp(headers: Headers): string {
  return (
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip") || "unknown"
  );
}
