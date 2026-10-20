// SPDX-License-Identifier: AGPL-3.0-only
import { createServer } from "node:net";

import { describe, expect, it } from "vitest";

import { isListening, isWindowsMountPath, portInUse } from "./platform.ts";

function listenOnRandomPort() {
  return new Promise<{ port: number; close: () => void }>((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ port, close: () => server.close() });
    });
  });
}

describe("portInUse / isListening", () => {
  it("reports a port with a listener as in use, and free after it closes", async () => {
    const { port, close } = await listenOnRandomPort();
    expect(await portInUse(port)).toBe(true);
    expect(await isListening(port)).toBe(true);
    close();
    await new Promise((r) => setTimeout(r, 50));
    expect(await portInUse(port)).toBe(false);
    expect(await isListening(port)).toBe(false);
  });
});

describe("isWindowsMountPath", () => {
  it("detects Windows drives mounted in WSL", () => {
    expect(isWindowsMountPath("/mnt/c/Users/robert/Documents/ClubAdmin")).toBe(true);
    expect(isWindowsMountPath("/mnt/d")).toBe(true);
    expect(isWindowsMountPath("/home/robert/ClubAdmin")).toBe(false);
    expect(isWindowsMountPath("/mnt/wsl/shared")).toBe(false);
  });
});
