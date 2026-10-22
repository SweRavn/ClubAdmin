// SPDX-License-Identifier: AGPL-3.0-only
import { request } from "node:https";
import { connect, type DetailedPeerCertificate } from "node:tls";

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

const CERTIFICATE_ERRORS = new Set([
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_SIGNATURE_FAILURE",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** True for a TLS error saying the server's certificate could not be verified. */
export function isCertificateError(error: unknown): error is Error & { code: string } {
  const code = (error as { code?: unknown } | null)?.code;
  return error instanceof Error && typeof code === "string" && CERTIFICATE_ERRORS.has(code);
}

/**
 * The certificate chain a server presents for `url` (without verifying it),
 * one line per certificate, for error messages.
 */
export function servedChain(url: string, connectTo = "127.0.0.1"): Promise<string[]> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = connect(
      {
        host: connectTo,
        port: target.port === "" ? 443 : Number(target.port),
        servername: target.hostname,
        rejectUnauthorized: false,
      },
      () => {
        const lines: string[] = [];
        const seen = new Set<string>();
        let cert: DetailedPeerCertificate | undefined = socket.getPeerCertificate(true);
        while (cert?.fingerprint256 && !seen.has(cert.fingerprint256)) {
          seen.add(cert.fingerprint256);
          const subject = String(cert.subject.CN || cert.subjectaltname || "?");
          const issuer = String(cert.issuer.CN || "?");
          lines.push(`${subject} (issuer: ${issuer}, valid until ${cert.valid_to})`);
          cert = cert.issuerCertificate;
        }
        socket.end();
        resolve(lines);
      },
    );
    socket.setTimeout(5_000, () => socket.destroy(new Error(`timeout connecting to ${url}`)));
    socket.on("error", reject);
  });
}
