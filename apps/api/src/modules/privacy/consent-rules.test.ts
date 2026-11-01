// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { consentRights, currentTextVersion, giveRefusal } from "./consent-rules.ts";

const ageRules = { consentAge: 13, ownAccountMinAge: 13, adultAge: 18 };
const now = new Date("2026-11-01T12:00:00Z");
const born = (age: number) => `${2026 - age}-06-01`;
const facts = (age: number | null, extra: Partial<Parameters<typeof consentRights>[1]> = {}) => ({
  purpose: "photo_publication" as const,
  asked: true,
  protected: false,
  birthDate: age === null ? null : born(age),
  ageRules,
  open: false,
  ...extra,
});

describe("consent rules", () => {
  it("a 12-year-old cannot give; their parent can", () => {
    expect(consentRights("self", facts(12), now).mayGive).toBe(false);
    expect(consentRights("guardian", facts(12), now).mayGive).toBe(true);
  });

  it("from 13 the young person decides; the parent may still withdraw until 18", () => {
    expect(consentRights("self", facts(14), now).mayGive).toBe(true);
    expect(consentRights("guardian", facts(14), now).mayGive).toBe(false);
    expect(consentRights("guardian", facts(14, { open: true }), now).mayWithdraw).toBe(true);
    expect(consentRights("guardian", facts(18, { open: true }), now).mayWithdraw).toBe(false);
  });

  it("an unknown birth date counts as an adult", () => {
    expect(consentRights("self", facts(null), now).mayGive).toBe(true);
    expect(consentRights("guardian", facts(null), now).mayGive).toBe(false);
  });

  it("refuses purposes the club does not ask for, and photos of a protected person", () => {
    expect(giveRefusal("self", facts(30, { asked: false }), now)).toBe("consent_purpose_not_asked");
    expect(giveRefusal("admin", facts(30, { protected: true }), now)).toBe(
      "consent_not_applicable",
    );
    expect(
      giveRefusal("self", facts(30, { protected: true, purpose: "marketing" }), now),
    ).toBeNull();
    expect(giveRefusal("self", facts(10), now)).toBe("consent_age_required");
  });

  it("administrators record and withdraw on request", () => {
    expect(consentRights("admin", facts(10), now)).toEqual({ mayGive: true, mayWithdraw: false });
    expect(consentRights("admin", facts(10, { open: true }), now).mayWithdraw).toBe(true);
  });

  it("names the club's latest text or the default", () => {
    expect(currentTextVersion("photo_publication", 2)).toBe("club:2");
    expect(currentTextVersion("photo_publication", null)).toBe("default:1");
  });
});
