// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { ClamdScanner, parseClamdReply, virusScanConfigIssues } from "./virus-scan.ts";

/** A fake clamd: reads INSTREAM and answers per the received bytes. */
function fakeClamd(answer: (data: Buffer) => string): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const command = "zINSTREAM\0";
        if (buffer.length < command.length) return;
        let offset = command.length;
        const parts: Buffer[] = [];
        while (offset + 4 <= buffer.length) {
          const size = buffer.readUInt32BE(offset);
          if (size === 0) {
            socket.end(`${answer(Buffer.concat(parts))}\0`);
            return;
          }
          if (offset + 4 + size > buffer.length) return;
          parts.push(buffer.subarray(offset + 4, offset + 4 + size));
          offset += 4 + size;
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0 });
    });
  });
}

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

describe("ClamdScanner", () => {
  it("streams the file in chunks and reads the verdict", async () => {
    const received: Buffer[] = [];
    const fake = await fakeClamd((data) => {
      received.push(data);
      return data.includes("EICAR") ? "stream: Eicar-Test-Signature FOUND" : "stream: OK";
    });
    server = fake.server;
    const scanner = new ClamdScanner({ host: "127.0.0.1", port: fake.port, timeoutMs: 5_000 });
    const big = Buffer.alloc(200_000, 7);
    expect(await scanner.scan(big)).toEqual({ result: "clean" });
    expect(received[0]?.equals(big)).toBe(true);
    expect(await scanner.scan(Buffer.from("X5O!P%@AP EICAR test"))).toEqual({
      result: "infected",
      signature: "Eicar-Test-Signature",
    });
  });

  it("fails when clamd cannot be reached", async () => {
    const scanner = new ClamdScanner({ host: "127.0.0.1", port: 1, timeoutMs: 2_000 });
    await expect(scanner.scan(Buffer.from("x"))).rejects.toThrow(/clamd/);
  });
});

describe("parseClamdReply", () => {
  it("reads OK, FOUND and errors", () => {
    expect(parseClamdReply("stream: OK\0")).toEqual({ result: "clean" });
    expect(() => parseClamdReply("INSTREAM size limit exceeded. ERROR\0")).toThrow(/ERROR/);
  });
});

describe("virusScanConfigIssues", () => {
  it("requires clamd in production only", () => {
    const base = { CLAMAV_PORT: 3310, CLAMAV_TIMEOUT_MS: 1000 };
    expect(virusScanConfigIssues({ ...base, NODE_ENV: "production" })).toHaveLength(1);
    expect(
      virusScanConfigIssues({ ...base, NODE_ENV: "production", CLAMAV_HOST: "clamav" }),
    ).toHaveLength(0);
    expect(virusScanConfigIssues({ ...base, NODE_ENV: "development" })).toHaveLength(0);
  });
});
