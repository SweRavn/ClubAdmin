// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { PACKAGE_NAME } from "./index.js";

describe("@clubadmin/shared", () => {
  it("loads", () => {
    expect(PACKAGE_NAME).toBe("@clubadmin/shared");
  });
});
