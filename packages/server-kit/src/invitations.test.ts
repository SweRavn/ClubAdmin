// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  emailInvitationToken,
  hashInvitationSecret,
  invitationUrl,
  randomInvitationCode,
  randomInvitationToken,
} from "./invitations.ts";

describe("invitation secrets", () => {
  it("derives the same email token from the same key and ID, and a different one otherwise", () => {
    const key = "k".repeat(32);
    const id = "0192f3c4-0000-7000-8000-000000000001";
    expect(emailInvitationToken(key, id)).toBe(emailInvitationToken(key, id));
    expect(emailInvitationToken(key, id)).not.toBe(emailInvitationToken("x".repeat(32), id));
    expect(emailInvitationToken(key, id)).toMatch(/^[\w-]{43}$/);
  });

  it("makes random tokens and 8-character codes without look-alikes", () => {
    expect(randomInvitationToken()).not.toBe(randomInvitationToken());
    for (let i = 0; i < 50; i++) expect(randomInvitationCode()).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);
  });

  it("hashes secrets and builds the accept link", () => {
    expect(hashInvitationSecret("abc")).toBe(hashInvitationSecret("abc"));
    expect(invitationUrl("https://clubadmin.localhost", "a_b-c")).toBe(
      "https://clubadmin.localhost/join/a_b-c",
    );
  });
});
