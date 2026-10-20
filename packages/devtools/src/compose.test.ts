// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { composeBaseArgs, parseComposePs } from "./compose.ts";
import { nodeVersionCheck } from "./doctor.ts";
import { trustSteps } from "./trust-ca.ts";

describe("parseComposePs", () => {
  it("parses newline-delimited JSON", () => {
    const output =
      '{"Service":"postgres","State":"running","Health":"healthy"}\n{"Service":"caddy","State":"exited","Health":""}\n';
    expect(parseComposePs(output)).toEqual([
      { service: "postgres", state: "running", health: "healthy" },
      { service: "caddy", state: "exited", health: "" },
    ]);
  });

  it("parses the older JSON array format and empty output", () => {
    expect(parseComposePs('[{"Service":"valkey","State":"running"}]')).toEqual([
      { service: "valkey", state: "running", health: "" },
    ]);
    expect(parseComposePs("")).toEqual([]);
  });
});

describe("composeBaseArgs", () => {
  it("uses the project name and both compose files, and the full profile on request", () => {
    const args = composeBaseArgs({ full: true });
    expect(args.slice(0, 3)).toEqual(["compose", "--project-name", "clubadmin"]);
    expect(args.filter((a) => a.endsWith(".yml")).map((a) => a.split("/").pop())).toEqual([
      "compose.yml",
      "compose.dev.yml",
    ]);
    expect(args.slice(-2)).toEqual(["--profile", "full"]);
  });
});

describe("nodeVersionCheck", () => {
  it("compares major versions", () => {
    expect(nodeVersionCheck("v24.22.0", "24.22.0").status).toBe("ok");
    expect(nodeVersionCheck("v24.1.0", "24.22.0").status).toBe("ok");
    expect(nodeVersionCheck("v22.22.0", "24.22.0").status).toBe("fail");
  });
});

describe("trustSteps", () => {
  it("uses the System keychain on macOS", () => {
    const [step] = trustSteps("darwin", "/tmp/ca.crt");
    expect(step?.args).toContain("/Library/Keychains/System.keychain");
  });

  it("has no automatic steps on Windows", () => {
    expect(trustSteps("win32", "C:\\ca.crt")).toEqual([]);
  });
});
