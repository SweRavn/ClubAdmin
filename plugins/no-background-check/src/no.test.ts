// SPDX-License-Identifier: AGPL-3.0-only
// The Norwegian attest: the club's confirmation of purpose as the request,
// the attest recorded when shown; the plugin through the conformance suite.

import { checkConformance, testContext } from "@clubadmin/plugin-api/testing";
import { describe, expect, it } from "vitest";

import { noBackgroundCheck } from "./index.ts";

const PERSON = "0199a000-0000-7000-8000-000000000011";
const NOW = new Date("2026-11-28T10:00:00Z");
const club = {
  id: "0199a000-0000-7000-8001-0000000000fe",
  country: "NO",
  timeZone: "Europe/Oslo",
  locale: "nb-NO",
};
const checks = noBackgroundCheck.backgroundChecks!;

describe("no.nif.politiattest", () => {
  it("passes the conformance suite", async () => {
    expect(
      await checkConformance(noBackgroundCheck, {
        club,
        now: NOW,
        checks: {
          requests: [{ personId: PERSON, checkType: "attest" }],
          presented: [{ personId: PERSON, checkType: "attest", issuedOn: "2026-11-01" }],
        },
      }),
    ).toEqual([]);
  });

  it("keeps the confirmation of purpose as a request until the attest is shown", async () => {
    const ctx = testContext({ club, now: NOW });
    const started = await checks.startRequest!(ctx, { personId: PERSON, checkType: "attest" });
    expect(started).toEqual({
      reference: `purpose-${PERSON}-2026-11-28`,
      status: "requested",
      result: null,
    });
    expect((await checks.requestStatus!(ctx, started.reference)).status).toBe("requested");
  });

  it("records a shown attest of any age, without an expiry", async () => {
    const ctx = testContext({ club, now: NOW });
    expect(
      await checks.verifyPresented!(ctx, {
        personId: PERSON,
        checkType: "attest",
        issuedOn: "2021-03-01",
        method: "digital_mailbox",
      }),
    ).toEqual({
      outcome: "verified",
      result: {
        checkType: "attest",
        issuingCountry: "NO",
        issuedOn: "2021-03-01",
        method: "digital_mailbox",
        validUntil: null,
      },
    });
  });
});
