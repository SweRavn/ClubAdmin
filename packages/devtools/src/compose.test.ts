// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { composeBaseArgs, notRunning, parseComposePs } from "./compose.ts";
import { nodeVersionCheck } from "./doctor.ts";
import { isCertificateError } from "./https.ts";
import { androidEmulatorSteps, iosSimulatorSteps, trustSteps } from "./trust-ca.ts";

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

describe("notRunning", () => {
  it("lists services that exited, were only created or do not exist", () => {
    const states = [
      { service: "postgres", state: "running", health: "healthy" },
      { service: "caddy", state: "created", health: "" },
      { service: "mailpit", state: "exited", health: "" },
    ];
    expect(notRunning(states, ["postgres", "caddy", "mailpit", "valkey"])).toEqual([
      "caddy",
      "mailpit",
      "valkey",
    ]);
  });
});

describe("isCertificateError", () => {
  it("recognises TLS verification errors only", () => {
    const tls = Object.assign(new Error("unable to get local issuer certificate"), {
      code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    });
    const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    expect(isCertificateError(tls)).toBe(true);
    expect(isCertificateError(refused)).toBe(false);
    expect(isCertificateError("UNABLE_TO_GET_ISSUER_CERT_LOCALLY")).toBe(false);
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

describe("trust-ca on simulators and emulators", () => {
  it("adds the CA to booted iOS simulators", () => {
    expect(iosSimulatorSteps("/ca.crt")).toEqual([
      { command: "xcrun", args: ["simctl", "keychain", "booted", "add-root-cert", "/ca.crt"] },
    ]);
  });

  it("puts the CA in the emulator's user store and forwards port 443", () => {
    const steps = androidEmulatorSteps("/ca.crt", "1a2b3c4d");
    expect(steps.map((s) => [s.command, ...s.args].join(" "))).toEqual([
      "adb root",
      "adb wait-for-device",
      "adb shell mkdir -p /data/misc/user/0/cacerts-added",
      "adb push /ca.crt /data/misc/user/0/cacerts-added/1a2b3c4d.0",
      "adb shell chmod 644 /data/misc/user/0/cacerts-added/1a2b3c4d.0",
      "adb reverse tcp:443 tcp:443",
    ]);
  });
});
