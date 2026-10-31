// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { DEMO_PASSWORD, idpPersonas, idpSyncRefusal, syncPersonas } from "./idp-sync.ts";

describe("idp-sync", () => {
  it("takes the personas who log in themselves", () => {
    const personas = idpPersonas();
    expect(personas.map((p) => p.key)).toContain("anna");
    expect(personas.every((p) => p.email.endsWith(".test"))).toBe(true);
  });

  it("runs only in development against the local issuer", () => {
    const env = (values: Record<string, string>) => new Map(Object.entries(values));
    expect(
      idpSyncRefusal(
        env({ NODE_ENV: "development", AUTH_ISSUER: "https://auth.clubadmin.localhost" }),
      ),
    ).toBeNull();
    expect(
      idpSyncRefusal(
        env({ NODE_ENV: "production", AUTH_ISSUER: "https://auth.clubadmin.localhost" }),
      ),
    ).toMatch(/NODE_ENV/);
    expect(
      idpSyncRefusal(env({ NODE_ENV: "development", AUTH_ISSUER: "https://auth.example.org" })),
    ).toMatch(/AUTH_ISSUER/);
  });

  it("creates missing users, resets the password of existing ones and links the accounts", async () => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const fake = ((url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ method: init.method ?? "GET", path, body });
      if (path === "/management/v1/users/_search") {
        const email = (body as { queries: { emailQuery: { emailAddress: string } }[] }).queries[0]!
          .emailQuery.emailAddress;
        return Promise.resolve(
          Response.json(email === "anna@example.test" ? { result: [{ id: "u-anna" }] } : {}),
        );
      }
      if (path === "/v2/users/human") return Promise.resolve(Response.json({ userId: "u-new" }));
      return Promise.resolve(Response.json({}));
    }) as typeof fetch;
    const updates: unknown[][] = [];
    const result = await syncPersonas({
      baseUrl: "https://auth.clubadmin.localhost",
      token: "t",
      personas: [
        { key: "anna", givenName: "Anna", familyName: "L", email: "anna@example.test" },
        { key: "erik", givenName: "Erik", familyName: "J", email: "erik@example.test" },
      ],
      query: ((_text: string, values?: unknown[]) => {
        updates.push(values ?? []);
        return Promise.resolve({ rows: [{ id: "a" }] });
      }) as never,
      fetch: fake,
    });
    expect(result).toEqual({ created: 1, updated: 1, linked: 2 });
    expect(calls.find((c) => c.path === "/v2/users/u-anna/password")?.body).toEqual({
      newPassword: { password: DEMO_PASSWORD, changeRequired: false },
    });
    expect(calls.find((c) => c.path === "/v2/users/human")?.body).toMatchObject({
      email: { email: "erik@example.test", isVerified: true },
    });
    expect(updates).toEqual([
      ["u-anna", "anna@example.test"],
      ["u-new", "erik@example.test"],
    ]);
  });
});
