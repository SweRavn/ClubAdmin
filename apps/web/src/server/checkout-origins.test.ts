// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { checkoutOrigins } from "./config.ts";

describe("checkout origins (P1.13 part B)", () => {
  it("keeps https origins only, without paths", () => {
    expect(
      checkoutOrigins({
        BILLING_CHECKOUT_ORIGINS: "https://checkout.stripe.com/x, http://evil.example, not a url",
      } as unknown as NodeJS.ProcessEnv),
    ).toEqual(["https://checkout.stripe.com"]);
    expect(checkoutOrigins({} as NodeJS.ProcessEnv)).toEqual([]);
  });
});
