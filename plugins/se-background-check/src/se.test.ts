// SPDX-License-Identifier: AGPL-3.0-only
// The Swedish extract: at most six months old when shown, nothing kept but
// the dates and how it was seen; the plugin through the conformance suite.

import { checkConformance, testContext } from "@clubadmin/plugin-api/testing";
import { describe, expect, it } from "vitest";

import { lastDayToShow, seBackgroundCheck } from "./index.ts";

const PERSON = "0199a000-0000-7000-8000-000000000005";
const ctx = testContext({ now: new Date("2026-11-28T10:00:00Z") });
const verify = (issuedOn: string, method?: "viewed" | "digital_mailbox") =>
  seBackgroundCheck.backgroundChecks!.verifyPresented!(ctx, {
    personId: PERSON,
    checkType: "extract",
    issuedOn,
    ...(method ? { method } : {}),
  });

describe("se.rf.registerutdrag", () => {
  it("passes the conformance suite", async () => {
    expect(
      await checkConformance(seBackgroundCheck, {
        now: new Date("2026-11-28T10:00:00Z"),
        checks: {
          presented: [
            { personId: PERSON, checkType: "extract", issuedOn: "2026-10-01" },
            { personId: PERSON, checkType: "extract", issuedOn: "2025-01-01" },
          ],
        },
      }),
    ).toEqual([]);
  });

  it("accepts an extract at most six calendar months old", async () => {
    expect(lastDayToShow("2026-05-28")).toBe("2026-11-28");
    expect(lastDayToShow("2026-08-31")).toBe("2027-02-28");
    expect(await verify("2026-05-28")).toEqual({
      outcome: "verified",
      result: {
        checkType: "extract",
        issuingCountry: "SE",
        issuedOn: "2026-05-28",
        method: "viewed",
        validUntil: null,
      },
    });
    expect(await verify("2026-05-27")).toEqual({
      outcome: "not_verified",
      reason: "se.bc.too_old",
    });
  });

  it("records how it was seen, and refuses a date in the future", async () => {
    const shown = await verify("2026-11-01", "digital_mailbox");
    expect(shown.outcome === "verified" && shown.result.method).toBe("digital_mailbox");
    expect(await verify("2026-12-01")).toEqual({ outcome: "not_verified", reason: "se.bc.future" });
  });

  it("requires the extract for contact with children, recommends it for the board", async () => {
    const reqs = await seBackgroundCheck.backgroundChecks!.requirements(ctx);
    expect(reqs.filter((r) => r.level === "required").map((r) => r.category)).toEqual([
      "regular_contact_with_children",
      "alone_with_children",
      "overnight",
    ]);
    expect(reqs.find((r) => r.category === "board")?.level).toBe("recommended");
  });
});
