// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { onBehalfApplies } from "./api.ts";
import { contentSecurityPolicy, newNonce, SECURITY_HEADERS } from "./security-headers.ts";

const directives = (policy: string) =>
  new Map(
    policy.split("; ").map((d) => {
      const [name = "", ...values] = d.split(" ");
      return [name, values] as const;
    }),
  );

describe("content security policy", () => {
  const nonce = newNonce();
  const production = directives(
    contentSecurityPolicy({ nonce, development: false, formActions: ["https://auth.example"] }),
  );

  it("allows scripts and styles only with the request's nonce, never inline or eval", () => {
    expect(production.get("script-src")).toEqual([
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
    ]);
    expect(production.get("style-src")).toEqual(["'self'", `'nonce-${nonce}'`]);
    for (const values of production.values()) {
      expect(values).not.toContain("'unsafe-inline'");
      expect(values).not.toContain("'unsafe-eval'");
    }
  });

  it("forbids framing, plugins and base changes; enforces Trusted Types", () => {
    expect(production.get("frame-ancestors")).toEqual(["'none'"]);
    expect(production.get("object-src")).toEqual(["'none'"]);
    expect(production.get("base-uri")).toEqual(["'none'"]);
    expect(production.get("form-action")).toEqual(["'self'", "https://auth.example"]);
    expect(production.get("require-trusted-types-for")).toEqual(["'script'"]);
  });

  it("relaxes only next dev (eval and the error overlay's styles), never inline scripts", () => {
    const dev = directives(contentSecurityPolicy({ nonce, development: true, formActions: [] }));
    expect(dev.get("script-src")).toContain("'unsafe-eval'");
    expect(dev.get("script-src")).not.toContain("'unsafe-inline'");
    expect(dev.get("style-src")).toContain("'unsafe-inline'");
    expect(dev.has("require-trusted-types-for")).toBe(false);
  });

  it("uses a fresh 128-bit nonce", () => {
    expect(Buffer.from(nonce, "base64")).toHaveLength(16);
    expect(newNonce()).not.toBe(nonce);
  });

  it("sets the other security headers", () => {
    const names = SECURITY_HEADERS.map((h) => h.key);
    expect(names).toEqual(
      expect.arrayContaining(["X-Frame-Options", "X-Content-Type-Options", "Referrer-Policy"]),
    );
  });
});

describe("X-On-Behalf-Of", () => {
  it.each([
    ["/api/v1/me/clubs", true],
    ["/api/v1/me/groups", true],
    ["/api/v1/groups/x/members?cursor=y", true],
    ["/api/v1/me", false],
    ["/api/v1/me/wards", false],
    ["/api/v1/me/sessions/abc", false],
    ["/api/v1/me/preferences", false],
    ["/api/v1/meta/source", false],
  ])("%s → %s", (path, expected) => {
    expect(onBehalfApplies(path)).toBe(expected);
  });
});
