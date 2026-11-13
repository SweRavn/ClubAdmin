// SPDX-License-Identifier: AGPL-3.0-only
// Virus scanning with ClamAV (P2.2, ADR 0049 decision 7; docs/security.md):
// the worker streams every uploaded file to clamd (INSTREAM over TCP) before
// the file becomes visible. Without CLAMAV_HOST, files are not scanned
// outside production (development without `pnpm dev:services --full`, tests);
// production requires it.

import { connect } from "node:net";

import { z } from "@clubadmin/shared";

export const virusScanConfigShape = {
  /** clamd's host (the compose service `clamav` with `pnpm dev:services --full`). */
  CLAMAV_HOST: z.string().optional(),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  /** How long a scan may take. */
  CLAMAV_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
};

export interface VirusScanConfig {
  NODE_ENV: string;
  CLAMAV_HOST?: string | undefined;
  CLAMAV_PORT: number;
  CLAMAV_TIMEOUT_MS: number;
}

/** Configuration problems (production needs a scanner). */
export function virusScanConfigIssues(
  config: VirusScanConfig,
): { variable: string; message: string }[] {
  return config.NODE_ENV === "production" && !config.CLAMAV_HOST
    ? [{ variable: "CLAMAV_HOST", message: "required in production: uploaded files are scanned" }]
    : [];
}

export type ScanVerdict = { result: "clean" } | { result: "infected"; signature: string };

export interface VirusScanner {
  scan(data: Buffer): Promise<ScanVerdict>;
}

export class VirusScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VirusScanError";
  }
}

/** The bytes clamd reads per chunk of INSTREAM. */
const CHUNK = 64 * 1024;

/** clamd over TCP: `zINSTREAM`, length-prefixed chunks, a zero-length end. */
export class ClamdScanner implements VirusScanner {
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;

  constructor(options: { host: string; port: number; timeoutMs: number }) {
    this.host = options.host;
    this.port = options.port;
    this.timeoutMs = options.timeoutMs;
  }

  scan(data: Buffer): Promise<ScanVerdict> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.port });
      const replies: Buffer[] = [];
      let settled = false;
      const finish = (error: Error | null, verdict?: ScanVerdict) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error);
        else resolve(verdict!);
      };
      socket.setTimeout(this.timeoutMs, () => finish(new VirusScanError("clamd timed out")));
      socket.on("error", (error) => finish(new VirusScanError(`clamd: ${error.message}`)));
      socket.on("data", (chunk: Buffer) => replies.push(chunk));
      socket.on("end", () => {
        try {
          finish(null, parseClamdReply(Buffer.concat(replies).toString("utf8")));
        } catch (error) {
          finish(error as Error);
        }
      });
      socket.on("connect", () => {
        socket.write("zINSTREAM\0");
        for (let offset = 0; offset < data.length; offset += CHUNK) {
          const part = data.subarray(offset, offset + CHUNK);
          const size = Buffer.alloc(4);
          size.writeUInt32BE(part.length, 0);
          socket.write(size);
          socket.write(part);
        }
        socket.write(Buffer.alloc(4));
      });
    });
  }
}

/** clamd's answer: `stream: OK`, `stream: <signature> FOUND` or an error. */
export function parseClamdReply(reply: string): ScanVerdict {
  const text = reply.replace(/\0/g, "").trim();
  if (/^stream: OK$/.test(text)) return { result: "clean" };
  const found = /^stream: (.+) FOUND$/.exec(text);
  if (found) return { result: "infected", signature: found[1]! };
  throw new VirusScanError(`clamd: ${text.slice(0, 200) || "no reply"}`);
}

/** The scanner of the configuration, or null (not configured: outside production only). */
export function virusScanner(config: VirusScanConfig): VirusScanner | null {
  return config.CLAMAV_HOST
    ? new ClamdScanner({
        host: config.CLAMAV_HOST,
        port: config.CLAMAV_PORT,
        timeoutMs: config.CLAMAV_TIMEOUT_MS,
      })
    : null;
}
