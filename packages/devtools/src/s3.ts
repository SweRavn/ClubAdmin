// SPDX-License-Identifier: AGPL-3.0-only
// Minimal AWS Signature Version 4 signing, enough for the dev smoke test to
// talk to Garage without pulling in an S3 SDK.

import { createHash, createHmac } from "node:crypto";

const sha256Hex = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) =>
  createHmac("sha256", key).update(data).digest();

const encodeRfc3986 = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

export interface SignInput {
  method: string;
  url: URL;
  region: string;
  service?: string;
  accessKeyId: string;
  secretAccessKey: string;
  body?: string | Buffer;
  /** Extra headers to send and sign (lower-case names). */
  headers?: Record<string, string>;
  now?: Date;
}

/** Returns all headers (including Authorization) for the request. */
export function signV4(input: SignInput): Record<string, string> {
  const service = input.service ?? "s3";
  const now = input.now ?? new Date();
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(input.body ?? "");

  const headers: Record<string, string> = {
    host: input.url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...Object.fromEntries(
      Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    ),
  };
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h]?.trim()}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalUri =
    input.url.pathname
      .split("/")
      .map((segment) => encodeRfc3986(decodeURIComponent(segment)))
      .join("/") || "/";
  const canonicalQuery = [...input.url.searchParams.entries()]
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${input.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, dateStamp), input.region), service),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
