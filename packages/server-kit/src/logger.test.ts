// SPDX-License-Identifier: AGPL-3.0-only
import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { createLogger } from "./logger.ts";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      }
      callback();
    },
  });
  return { lines, destination };
}

describe("createLogger", () => {
  it("redacts personal data in log objects, also nested and in errors", () => {
    const { lines, destination } = capture();
    const logger = createLogger({ service: "test", destination });
    logger.info(
      {
        personId: "p1",
        email: "anna.lindqvist@example.test",
        member: { givenName: "Anna", phone: "+4670" },
      },
      "member updated",
    );
    logger.error(
      { err: Object.assign(new Error("failed"), { personalIdentityNumber: "19800101-0000" }) },
      "oops",
    );

    const output = JSON.stringify(lines);
    expect(output).not.toContain("anna.lindqvist@example.test");
    expect(output).not.toContain("Anna");
    expect(output).not.toContain("+4670");
    expect(output).not.toContain("19800101-0000");
    expect(lines[0]).toMatchObject({
      level: "info",
      service: "test",
      personId: "p1",
      msg: "member updated",
    });
    expect(lines[1]).toMatchObject({ level: "error", err: { message: "failed" } });
  });
});
