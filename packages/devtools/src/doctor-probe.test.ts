// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { HOST_PROBES, probePort } from "./doctor.ts";

let server: Server | undefined;
afterEach(() => server?.close());

const listen = (onSocket: (socket: Socket) => void) =>
  new Promise<number>((resolve) => {
    server = createServer(onSocket).listen(0, "127.0.0.1", () => {
      const address = server!.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });

describe("host-side service probes", () => {
  it("accepts Valkey's PONG", async () => {
    const port = await listen((socket) => socket.on("data", () => socket.write("+PONG\r\n")));
    const valkey = HOST_PROBES.find((p) => p.service === "valkey")!;
    expect(valkey.ok(await probePort(port, valkey.request))).toBe(true);
  });

  it("reports a port that accepts and resets, as a broken port forward does", async () => {
    const port = await listen((socket) => socket.resetAndDestroy());
    const answer = await probePort(port, Buffer.from("PING\r\n"));
    expect(answer).toMatch(/^error/);
  });
});
