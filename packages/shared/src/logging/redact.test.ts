// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { redact, REDACTED } from "./redact.ts";

describe("redact", () => {
  it("redacts sensitive keys at any depth and in any naming style", () => {
    const input = {
      personId: "0190a1b2-0000-7000-8000-000000000001",
      email: "anna.lindqvist@example.test",
      profile: { given_name: "Anna", "Family-Name": "Lindqvist", phone: "+46700000000" },
      people: [{ personalIdentityNumber: "19800101-0000", role: "chair" }],
      headers: { authorization: "Bearer abc", cookie: "session=1", accept: "application/json" },
    };
    expect(redact(input)).toEqual({
      personId: "0190a1b2-0000-7000-8000-000000000001",
      email: REDACTED,
      profile: { given_name: REDACTED, "Family-Name": REDACTED, phone: REDACTED },
      people: [{ personalIdentityNumber: REDACTED, role: "chair" }],
      headers: { authorization: REDACTED, cookie: REDACTED, accept: "application/json" },
    });
  });

  it("does not modify the original object", () => {
    const input = { email: "a@example.test" };
    redact(input);
    expect(input.email).toBe("a@example.test");
  });

  it("handles cycles, errors, maps and buffers", () => {
    const cyclic: Record<string, unknown> = { id: 1 };
    cyclic.self = cyclic;
    const error = Object.assign(new Error("boom"), { email: "x@example.test" });
    const result = redact({
      cyclic,
      error,
      map: new Map([["token", "t"]]),
      buf: Buffer.from("secret"),
    }) as Record<string, Record<string, unknown>>;
    expect(result.cyclic?.self).toBe("[circular]");
    expect(result.error).toMatchObject({ type: "Error", message: "boom", email: REDACTED });
    expect(result.map).toEqual({ token: REDACTED });
    expect(result.buf).toBe("[binary 6 bytes]");
  });

  it("passes primitives through", () => {
    expect(redact("plain")).toBe("plain");
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBeNull();
  });
});
