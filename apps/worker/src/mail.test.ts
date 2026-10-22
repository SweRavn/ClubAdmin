// SPDX-License-Identifier: AGPL-3.0-only
import { SUPPORTED_LOCALES } from "@clubadmin/i18n";
import { describe, expect, it } from "vitest";

import { render } from "./mail.ts";

const VALUES = {
  club: "Sjöviks VK",
  inviter: "Anna Berg",
  hasInviter: "yes",
  person: "Sofie Dahl",
  change: "appointed",
  hasMessage: "yes",
  message: "Welcome!",
  url: "https://clubadmin.test/",
  expires: "1 November 2026",
};

const KEYS = [
  "footer",
  "invitation.subject",
  "invitation.body",
  "joinRequest.approvedSubject",
  "joinRequest.approvedBody",
  "joinRequest.rejectedSubject",
  "joinRequest.rejectedBody",
  "managers.subject",
  "managers.body",
  "clubCreation.approvedSubject",
  "clubCreation.approvedBody",
  "clubCreation.rejectedSubject",
  "clubCreation.rejectedBody",
];

describe("email templates", () => {
  it("render in every language", () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const key of KEYS) {
        const text = render(locale, key, VALUES);
        expect(text, `${locale} ${key}`).not.toMatch(/[{}]/);
        expect(text.length).toBeGreaterThan(0);
      }
    }
  });

  it("leaves out the inviter and an empty message", () => {
    const body = render("en", "invitation.body", { ...VALUES, hasInviter: "no" });
    expect(body).toMatch(/^You are invited to join Sjöviks VK/);
    expect(render("sv", "joinRequest.rejectedBody", { ...VALUES, hasMessage: "no" })).not.toContain(
      "Welcome!",
    );
    for (const change of ["removed", "handed_over", "claimed", "reassigned"]) {
      expect(render("sv", "managers.body", { ...VALUES, change })).toContain("Sofie Dahl");
    }
  });
});
