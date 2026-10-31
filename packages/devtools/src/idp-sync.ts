// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm dev:idp-sync` (P1.6b): every demo persona with an account becomes a
// user of the local Zitadel with a verified email and the documented
// password `demo-password-123`, so the real login can be tried as Anna and
// the others. Idempotent: existing users get the password again. The
// persona's account is linked to the Zitadel user (accounts.idp_subject),
// since the API finds accounts by subject, never by email. Development
// only: refuses unless NODE_ENV=development and the issuer is local.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { AdminQuery } from "@clubadmin/db/admin";

import { repoRoot } from "./paths.ts";
import { ZitadelError } from "./zitadel.ts";

export const DEMO_PASSWORD = "demo-password-123";

export interface IdpPersona {
  key: string;
  givenName: string;
  familyName: string;
  email: string;
}

/** The personas that log in themselves (login "account" with an email). */
export function idpPersonas(
  file = join(repoRoot, "docs", "demodata", "personas.json"),
): IdpPersona[] {
  const { personas } = JSON.parse(readFileSync(file, "utf8")) as {
    personas: {
      key: string;
      givenName: string;
      familyName: string;
      login?: string;
      email?: string;
    }[];
  };
  return personas.flatMap((p) =>
    p.login === "account" && p.email
      ? [{ key: p.key, givenName: p.givenName, familyName: p.familyName, email: p.email }]
      : [],
  );
}

/** Development only: the local issuer and NODE_ENV=development. */
export function idpSyncRefusal(env: ReadonlyMap<string, string>): string | null {
  if (env.get("NODE_ENV") !== "development") return "NODE_ENV must be development";
  const issuer = env.get("AUTH_ISSUER");
  if (!issuer || !new URL(issuer).hostname.endsWith(".localhost")) {
    return "AUTH_ISSUER must be the local Zitadel (*.localhost)";
  }
  return null;
}

export async function syncPersonas(options: {
  baseUrl: string;
  token: string;
  personas: readonly IdpPersona[];
  /** Superuser connection to the development database. */
  query: AdminQuery;
  fetch?: typeof fetch;
  log?: (message: string) => void;
}): Promise<{ created: number; updated: number; linked: number }> {
  const base = options.baseUrl.replace(/\/$/, "");
  const doFetch = options.fetch ?? fetch;
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${options.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) throw new ZitadelError(method, path, res.status, text);
    return (text ? JSON.parse(text) : {}) as T;
  };

  let created = 0;
  let updated = 0;
  let linked = 0;
  for (const persona of options.personas) {
    const found = await api<{ result?: { id: string }[] }>("POST", "/management/v1/users/_search", {
      queries: [
        {
          emailQuery: {
            emailAddress: persona.email,
            method: "TEXT_QUERY_METHOD_EQUALS_IGNORE_CASE",
          },
        },
      ],
    });
    let userId = found.result?.[0]?.id;
    if (userId) {
      await api("POST", `/v2/users/${userId}/password`, {
        newPassword: { password: DEMO_PASSWORD, changeRequired: false },
      });
      updated++;
    } else {
      ({ userId } = await api<{ userId: string }>("POST", "/v2/users/human", {
        username: persona.email,
        profile: { givenName: persona.givenName, familyName: persona.familyName },
        email: { email: persona.email, isVerified: true },
        password: { password: DEMO_PASSWORD, changeRequired: false },
      }));
      created++;
    }
    // Link the persona's account to the Zitadel user (the API resolves logins by subject).
    const { rows } = await options.query<{ id: string }>(
      `UPDATE public.accounts SET idp_subject = $1
       WHERE lower(email) = lower($2) AND (idp_subject IS NULL OR idp_subject <> $1)
       RETURNING id`,
      [userId, persona.email],
    );
    linked += rows.length;
    options.log?.(`${persona.key}: ${persona.email}`);
  }
  return { created, updated, linked };
}
