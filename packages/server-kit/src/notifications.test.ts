// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  hashPushToken,
  openPushToken,
  renderNotice,
  sealPushToken,
  unsubscribeToken,
  verifyUnsubscribeToken,
} from "./notifications.ts";

const KEY = "notification-test-key-0123456789abcdef";
const ACCOUNT = "0199a000-0000-7000-8000-000000000001";

describe("unsubscribe tokens", () => {
  it("name the account and category and refuse anything changed", () => {
    const token = unsubscribeToken(KEY, ACCOUNT, "schedule");
    expect(verifyUnsubscribeToken(KEY, token)).toEqual({
      accountId: ACCOUNT,
      category: "schedule",
    });
    expect(verifyUnsubscribeToken(KEY, token.replace("schedule", "events"))).toBeNull();
    expect(verifyUnsubscribeToken("another-key-0123456789abcdefghijkl", token)).toBeNull();
    expect(verifyUnsubscribeToken(KEY, "nonsense")).toBeNull();
  });
});

describe("push tokens", () => {
  it("are sealed (different each time) and opened again; the hash is the lookup", () => {
    const token = "ExponentPushToken[abc123]";
    const a = sealPushToken(KEY, token);
    expect(a).not.toContain("abc123");
    expect(sealPushToken(KEY, token)).not.toBe(a);
    expect(openPushToken(KEY, a)).toBe(token);
    expect(() => openPushToken("another-key-0123456789abcdefghijkl", a)).toThrow();
    expect(hashPushToken(token)).toBe(hashPushToken(token));
  });
});

describe("notice texts", () => {
  it("render from the type and params in the locale, with the link", () => {
    const input = {
      type: "activity.cancelled",
      clubId: "0199a000-0000-7000-8001-000000000001",
      clubName: "SVK",
      subjectType: "activity",
      subjectId: "0199a000-0000-7000-8020-000000000001",
      params: {
        title: "Träning",
        group: "F2017",
        startsAt: "2026-11-03T16:30:00Z",
        timeZone: "Europe/Stockholm",
      },
    };
    const sv = renderNotice("sv", input);
    expect(sv.title).toMatch(/^Inställt: Träning .*17:30$/);
    expect(sv.body).toBe("SVK · F2017");
    expect(sv.link).toBe("/activities/0199a000-0000-7000-8020-000000000001");
    expect(renderNotice("en", input).title).toMatch(/^Cancelled: Träning/);
    expect(renderNotice("sv", { ...input, type: "something.new" }).title).toBe("Ny notis");
  });
});
