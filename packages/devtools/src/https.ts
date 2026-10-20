// SPDX-License-Identifier: AGPL-3.0-only
import { request } from "node:https";

export interface HttpsResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * HTTPS GET that trusts the given CA and connects to `connectTo` (default
 * 127.0.0.1) regardless of DNS, so *.localhost names work everywhere.
 */
export function httpsGet(
  url: string,
  options: { ca: string; connectTo?: string; timeoutMs?: number },
) {
  return new Promise<HttpsResponse>((resolve, reject) => {
    const target = new URL(url);
    const req = request(
      {
        host: options.connectTo ?? "127.0.0.1",
        port: target.port === "" ? 443 : Number(target.port),
        path: `${target.pathname}${target.search}`,
        method: "GET",
        servername: target.hostname,
        headers: { host: target.host },
        ca: options.ca,
        timeout: options.timeoutMs ?? 10_000,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("timeout", () => req.destroy(new Error(`timeout fetching ${url}`)));
    req.on("error", reject);
    req.end();
  });
}
