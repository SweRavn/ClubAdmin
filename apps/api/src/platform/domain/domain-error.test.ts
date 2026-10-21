// SPDX-License-Identifier: AGPL-3.0-only
import { PROBLEM_TYPES } from "@clubadmin/shared";
import { CreatePersonSchema } from "@clubadmin/shared";
import { describe, expect, it } from "vitest";

import { DOMAIN_ERRORS, DomainError, type DomainErrorCode, isDomainError } from "./domain-error.ts";
import { parseInput } from "./run.ts";

describe("domain errors", () => {
  it("carry only their code: no values, no cause", () => {
    for (const code of Object.keys(DOMAIN_ERRORS) as DomainErrorCode[]) {
      const error = new DomainError(code);
      expect(error.message).toBe(code);
      expect(error.detail).toBe(code);
      expect(error.cause).toBeUndefined();
      expect(error.status).toBe(PROBLEM_TYPES[DOMAIN_ERRORS[code]]);
    }
  });

  it("invalid input is reported without echoing the values", () => {
    let error: unknown;
    try {
      parseInput(CreatePersonSchema, {
        givenName: "Nadia",
        familyName: "",
        birthDate: "not-a-date",
      });
    } catch (e) {
      error = e;
    }
    expect(isDomainError(error, "invalid_input")).toBe(true);
    expect(JSON.stringify(error)).not.toContain("Nadia");
    expect(JSON.stringify(error)).not.toContain("not-a-date");
  });
});
