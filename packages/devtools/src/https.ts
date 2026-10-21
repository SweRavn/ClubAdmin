// SPDX-License-Identifier: AGPL-3.0-only
import { request } from "node:https";

export interface HttpsResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface HttpsOptions {
  ca: string;
  connectTo?: string;
  timeoutMs?: number;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * HTTPS request that trusts the given CA and connects to `connectTo` (default
 * 127.0.0.1) regardless of DNS, so *.localhost names work everywhere.
 */
export function httpsRequest(url: string, options: HttpsOptions) {
  return new Promise<HttpsResponse>((resolve, reject) => {
    const target = new URL(url);
    const req = request(
      {
        host: options.connectTo ?? "127.0.0.1",
        port: target.port === "" ? 443 : Number(target.port),
        path: `${target.pathname}${target.search}`,
        method: options.method ?? "GET",
        servername: target.hostname,
        headers: { ...options.headers, host: target.host },
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
    req.end(options.body);
  });
}

export const httpsGet = (url: string, options: Omit<HttpsOptions, "method" | "body">) =>
  httpsRequest(url, options);

/** A minimal `fetch` over httpsRequest (string bodies), for API clients in the dev tools. */
export function fetchWithCa(ca: string): typeof fetch {
  return (async (input: string | URL, init: RequestInit = {}) => {
    const res = await httpsRequest(String(input), {
      ca,
      method: init.method ?? "GET",
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      ...(typeof init.body === "string" ? { body: init.body } : {}),
    });
    return new Response(res.status === 204 ? null : res.body, { status: res.status });
  }) as typeof fetch;
}
