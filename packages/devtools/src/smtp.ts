// SPDX-License-Identifier: AGPL-3.0-only
// Minimal SMTP client for sending one plain-text test message (dev smoke test).

import { connect } from "node:net";

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export function sendMail(host: string, port: number, message: MailMessage, timeoutMs = 5000) {
  return new Promise<void>((resolve, reject) => {
    const socket = connect({ host, port });
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error("SMTP timeout")));

    const body = [
      `From: ${message.from}`,
      `To: ${message.to}`,
      `Subject: ${message.subject}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      // Dot-stuffing (RFC 5321 4.5.2).
      ...message.text.split(/\r?\n/).map((l) => (l.startsWith(".") ? `.${l}` : l)),
      ".",
    ].join("\r\n");
    const steps: [command: string | null, expectedCode: string][] = [
      [null, "220"],
      ["EHLO clubadmin.localhost", "250"],
      [`MAIL FROM:<${message.from}>`, "250"],
      [`RCPT TO:<${message.to}>`, "250"],
      ["DATA", "354"],
      [body, "250"],
      ["QUIT", "221"],
    ];
    let step = 0;
    let buffer = "";

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      // A complete reply ends with a line "NNN text" (no dash after the code).
      const lines = buffer.split("\r\n");
      const last = lines.length >= 2 ? lines[lines.length - 2] : undefined;
      if (last === undefined || !/^\d{3} /.test(last)) return;
      buffer = "";
      const expected = steps[step]?.[1];
      if (!last.startsWith(expected ?? "")) {
        socket.destroy();
        reject(new Error(`SMTP: expected ${expected}, got "${last}"`));
        return;
      }
      step++;
      const next = steps[step];
      if (!next) {
        socket.end();
        resolve();
        return;
      }
      socket.write(`${next[0]}\r\n`);
    });
    socket.on("error", reject);
  });
}
