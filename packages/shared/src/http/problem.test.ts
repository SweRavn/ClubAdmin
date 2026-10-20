// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { problemSlugForStatus, problemTypeUri } from "./problem.ts";

describe("problemSlugForStatus", () => {
  it("maps statuses to generic problem types", () => {
    expect(problemSlugForStatus(404)).toBe("not-found");
    expect(problemSlugForStatus(400)).toBe("bad-request");
    expect(problemSlugForStatus(429)).toBe("rate-limited");
    expect(problemSlugForStatus(418)).toBe("bad-request");
    expect(problemSlugForStatus(502)).toBe("internal");
  });

  it("builds documented type URIs", () => {
    expect(problemTypeUri("validation")).toMatch(/docs\/api\/problems\.md#validation$/);
  });
});
