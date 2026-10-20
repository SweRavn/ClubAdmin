// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync } from "node:fs";
import { connect, createServer } from "node:net";

/** True when running inside Windows Subsystem for Linux. */
export function isWsl(): boolean {
  return (
    process.platform === "linux" &&
    existsSync("/proc/version") &&
    /microsoft/i.test(readFileSync("/proc/version", "utf8"))
  );
}

/** True for paths on a Windows drive mounted into WSL (/mnt/c/...). */
export const isWindowsMountPath = (path: string) => /^\/mnt\/[a-z](\/|$)/i.test(path);

/** True if something accepts TCP connections on 127.0.0.1:port. */
export function isListening(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (listening: boolean) => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * Whether a local port is free for Docker to publish. Binding a port below 1024
 * fails with EACCES for normal users on Linux even when the port is free (Docker
 * itself can still publish it), so in that case fall back to a connection test.
 */
export function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(true);
      else resolve(isListening(port));
    });
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(false)));
  });
}
