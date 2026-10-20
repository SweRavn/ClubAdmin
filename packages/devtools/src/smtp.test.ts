// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { sendMail } from "./smtp.ts";

let server: Server | undefined;
afterEach(() => server?.close());

/** A tiny fake SMTP server that records the DATA section. */
function fakeSmtp(onMessage: (data: string) => void): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((socket) => {
      socket.setEncoding("utf8");
      let inData = false;
      let data = "";
      socket.write("220 fake ESMTP\r\n");
      socket.on("data", (chunk: string) => {
        if (inData) {
          data += chunk;
          if (data.endsWith("\r\n.\r\n")) {
            inData = false;
            onMessage(data);
            socket.write("250 queued\r\n");
          }
          return;
        }
        for (const line of chunk.split("\r\n").filter(Boolean)) {
          if (line.startsWith("EHLO")) socket.write("250-fake\r\n250 SIZE 1000\r\n");
          else if (line === "DATA") {
            inData = true;
            socket.write("354 go ahead\r\n");
          } else if (line === "QUIT") socket.end("221 bye\r\n");
          else socket.write("250 ok\r\n");
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

describe("sendMail", () => {
  it("delivers a message with headers and dot-stuffing", async () => {
    let received = "";
    const port = await fakeSmtp((data) => (received = data));
    await sendMail("127.0.0.1", port, {
      from: "a@clubadmin.test",
      to: "b@clubadmin.test",
      subject: "Hello",
      text: "line one\n.starts with dot",
    });
    expect(received).toContain("Subject: Hello\r\n");
    expect(received).toContain("\r\n..starts with dot\r\n.\r\n");
  });
});
