// SPDX-License-Identifier: AGPL-3.0-only
// Helpers for the end-to-end tests: Mailpit (verification codes), Zitadel's
// API (enrolling a TOTP second factor), TOTP codes.

import { createHmac } from "node:crypto";

export const MAILPIT_URL = process.env.MAILPIT_URL ?? "http://127.0.0.1:8025";
export const AUTH_URL = process.env.AUTH_ISSUER ?? "https://auth.clubadmin.localhost";

export const uniqueEmail = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@example.test`;

/** Waits for the newest email to `to` and returns its plain-text body. */
export async function waitForMail(to: string, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const search = await fetch(
      `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`,
    );
    const { messages } = (await search.json()) as { messages?: { ID: string }[] };
    if (messages?.[0]) {
      const message = await fetch(`${MAILPIT_URL}/api/v1/message/${messages[0].ID}`);
      const { Text, HTML } = (await message.json()) as { Text: string; HTML: string };
      return `${Text}\n${HTML}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("no email arrived");
}

/** The verification code in Zitadel's email (also in the link's `code` parameter). */
export function verificationCode(mail: string): string {
  const fromLink = /[?&;]code=([A-Za-z0-9]+)/.exec(mail.replaceAll("&amp;", "&"))?.[1];
  if (fromLink) return fromLink;
  const plain = /\b([A-Z0-9]{6,})\b/.exec(mail)?.[1];
  if (!plain) throw new Error("no verification code in the email");
  return plain;
}

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) for a base32 secret. */
export function totp(secret: string, time = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret.replace(/=+$/, "").toUpperCase()) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  }
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => Number.parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 1000 / 30)));
  const hmac = createHmac("sha1", key).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, "0");
}

async function zitadel<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = process.env.ZITADEL_PAT;
  if (!token) throw new Error("ZITADEL_PAT is needed to enrol a second factor");
  const res = await fetch(`${AUTH_URL}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`Zitadel ${method} ${path}: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** Enrols TOTP for the user with this login name (as the admin would on their behalf). Returns the secret. */
export async function enrolTotp(loginName: string): Promise<string> {
  const users = await zitadel<{ result?: { userId: string }[] }>("POST", "/v2/users", {
    queries: [{ loginNameQuery: { loginName, method: "TEXT_QUERY_METHOD_EQUALS" } }],
  });
  const userId = users.result?.[0]?.userId;
  if (!userId) throw new Error("user not found in Zitadel");
  const { secret } = await zitadel<{ secret: string }>("POST", `/v2/users/${userId}/totp`, {});
  await zitadel("POST", `/v2/users/${userId}/totp/verify`, { code: totp(secret) });
  return secret;
}
