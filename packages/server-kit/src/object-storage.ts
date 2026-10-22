// SPDX-License-Identifier: AGPL-3.0-only
// Object storage over the S3 API (ADR 0011): AWS Signature Version 4 and the
// handful of calls the application needs (multipart upload, delete,
// pre-signed downloads), on fetch, without an SDK. Path-style URLs, which
// Garage, SeaweedFS and the hosted providers all accept.

import { createHash, createHmac } from "node:crypto";

import { z } from "@clubadmin/shared";

const sha256Hex = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) =>
  createHmac("sha256", key).update(data).digest();

const encodeRfc3986 = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const amzDateOf = (now: Date) =>
  now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

const canonicalUri = (url: URL) =>
  url.pathname
    .split("/")
    .map((segment) => encodeRfc3986(decodeURIComponent(segment)))
    .join("/") || "/";

const canonicalQuery = (params: Iterable<[string, string]>) =>
  [...params]
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

function signingKey(secretAccessKey: string, dateStamp: string, region: string, service: string) {
  return hmac(
    hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service),
    "aws4_request",
  );
}

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
  const amzDate = amzDateOf(input.now ?? new Date());
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

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri(input.url),
    canonicalQuery(input.url.searchParams.entries()),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${input.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = createHmac(
    "sha256",
    signingKey(input.secretAccessKey, dateStamp, input.region, service),
  )
    .update(stringToSign)
    .digest("hex");

  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** A pre-signed GET URL (query-string authentication, unsigned payload). */
export function presignGetUrl(input: {
  url: URL;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresSeconds: number;
  /** Extra query parameters to sign, e.g. response-content-disposition. */
  query?: Record<string, string>;
  now?: Date;
}): string {
  const amzDate = amzDateOf(input.now ?? new Date());
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${input.region}/s3/aws4_request`;
  const url = new URL(input.url);
  const params: Record<string, string> = {
    ...input.query,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${input.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(input.expiresSeconds),
    "X-Amz-SignedHeaders": "host",
  };
  const query = canonicalQuery(Object.entries(params));
  const canonicalRequest = [
    "GET",
    canonicalUri(url),
    query,
    `host:${url.host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = createHmac(
    "sha256",
    signingKey(input.secretAccessKey, dateStamp, input.region, "s3"),
  )
    .update(stringToSign)
    .digest("hex");
  return `${url.origin}${canonicalUri(url)}?${query}&X-Amz-Signature=${signature}`;
}

/** S3_* settings (api and worker); without S3_ENDPOINT there is no object storage. */
export const objectStorageConfigShape = {
  S3_ENDPOINT: z.url().optional(),
  /** The endpoint browsers reach for pre-signed downloads; defaults to S3_ENDPOINT. */
  S3_PUBLIC_ENDPOINT: z.url().optional(),
  /**
   * The provider's region (part of every request signature). No default: a
   * guessed region only works for some providers (ADR 0011); required with
   * S3_ENDPOINT (objectStorageConfigIssues).
   */
  S3_REGION: z.string().min(1).optional(),
  S3_BUCKET_FILES: z.string().default("clubadmin-files"),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
} as const;

export interface ObjectStorageConfig {
  endpoint: string;
  publicEndpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Settings that only make sense together (for the API's and worker's config checks). */
export function objectStorageConfigIssues(env: {
  S3_ENDPOINT?: string | undefined;
  S3_REGION?: string | undefined;
}): { variable: string; message: string }[] {
  return env.S3_ENDPOINT && !env.S3_REGION
    ? [
        {
          variable: "S3_REGION",
          message: "required when S3_ENDPOINT is set (the provider's region)",
        },
      ]
    : [];
}

export function objectStorageConfig(env: {
  S3_ENDPOINT?: string | undefined;
  S3_PUBLIC_ENDPOINT?: string | undefined;
  S3_REGION?: string | undefined;
  S3_BUCKET_FILES: string;
  S3_ACCESS_KEY_ID?: string | undefined;
  S3_SECRET_ACCESS_KEY?: string | undefined;
}): ObjectStorageConfig | null {
  if (!env.S3_ENDPOINT || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) return null;
  if (!env.S3_REGION) throw new Error("S3_REGION is required when S3_ENDPOINT is set");
  return {
    endpoint: env.S3_ENDPOINT,
    publicEndpoint: env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET_FILES,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  };
}

export class ObjectStorageError extends Error {
  readonly status: number;

  constructor(operation: string, status: number) {
    // The response body may echo the key; keep it out of the message.
    super(`object storage ${operation} failed with HTTP ${status}`);
    this.name = "ObjectStorageError";
    this.status = status;
  }
}

const tag = (xml: string, name: string) =>
  new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(xml)?.[1] ?? null;

/** One bucket of S3-compatible object storage. */
export class ObjectStorage {
  readonly config: ObjectStorageConfig;

  constructor(config: ObjectStorageConfig) {
    this.config = config;
  }

  private objectUrl(key: string, base = this.config.endpoint): URL {
    const url = new URL(base);
    const prefix = url.pathname.replace(/\/$/, "");
    url.pathname = `${prefix}/${this.config.bucket}/${key.split("/").map(encodeRfc3986).join("/")}`;
    return url;
  }

  private async send(
    operation: string,
    method: string,
    url: URL,
    options: { body?: Buffer; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const headers = signedHeaders(this.config, method, url, options.body, options.headers);
    const init: RequestInit = { method, headers };
    if (options.body) init.body = new Uint8Array(options.body);
    const response = await fetch(url, init);
    if (!response.ok) {
      await response.body?.cancel();
      throw new ObjectStorageError(operation, response.status);
    }
    return response;
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    const response = await this.send("put", "PUT", this.objectUrl(key), {
      body,
      headers: { "content-type": contentType },
    });
    await response.body?.cancel();
  }

  async createMultipartUpload(key: string, contentType: string): Promise<string> {
    const url = this.objectUrl(key);
    url.searchParams.set("uploads", "");
    const response = await this.send("create multipart upload", "POST", url, {
      headers: { "content-type": contentType },
    });
    const uploadId = tag(await response.text(), "UploadId");
    if (!uploadId) throw new ObjectStorageError("create multipart upload", 502);
    return uploadId;
  }

  /** Uploads one part (all but the last at least 5 MiB) and returns its ETag. */
  async uploadPart(key: string, uploadId: string, partNumber: number, body: Buffer) {
    const url = this.objectUrl(key);
    url.searchParams.set("partNumber", String(partNumber));
    url.searchParams.set("uploadId", uploadId);
    const response = await this.send("upload part", "PUT", url, { body });
    await response.body?.cancel();
    const etag = response.headers.get("etag");
    if (!etag) throw new ObjectStorageError("upload part", 502);
    return etag;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: readonly { partNumber: number; etag: string }[],
  ): Promise<void> {
    const url = this.objectUrl(key);
    url.searchParams.set("uploadId", uploadId);
    const body = Buffer.from(
      `<CompleteMultipartUpload>${parts
        .map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`)
        .join("")}</CompleteMultipartUpload>`,
    );
    const response = await this.send("complete multipart upload", "POST", url, {
      body,
      headers: { "content-type": "application/xml" },
    });
    // S3 can answer 200 with an error document.
    const text = await response.text();
    if (text.includes("<Error>")) throw new ObjectStorageError("complete multipart upload", 500);
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    const url = this.objectUrl(key);
    url.searchParams.set("uploadId", uploadId);
    const response = await this.send("abort multipart upload", "DELETE", url);
    await response.body?.cancel();
  }

  /** Deletes the object; deleting a missing object succeeds. */
  async deleteObject(key: string): Promise<void> {
    const response = await this.send("delete", "DELETE", this.objectUrl(key));
    await response.body?.cancel();
  }

  /**
   * Makes sure the bucket deletes objects under `prefix` after `days` days
   * (and abandoned multipart uploads after one day). A bucket with other
   * lifecycle rules is left alone ("conflict"): PUT replaces the whole
   * configuration.
   */
  async ensureExpiryRule(rule: {
    id: string;
    prefix: string;
    days: number;
  }): Promise<"present" | "added" | "conflict"> {
    const url = new URL(this.config.endpoint);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${this.config.bucket}`;
    url.searchParams.set("lifecycle", "");
    const headers = signedHeaders(this.config, "GET", url, undefined, undefined);
    const current = await fetch(url, { headers });
    const text = await current.text();
    if (current.ok) {
      if (text.includes(`<ID>${rule.id}</ID>`)) return "present";
      if (text.includes("<Rule>")) return "conflict";
    } else if (current.status !== 404) {
      throw new ObjectStorageError("get lifecycle", current.status);
    }
    const body = Buffer.from(
      `<LifecycleConfiguration><Rule><ID>${rule.id}</ID><Status>Enabled</Status>` +
        `<Filter><Prefix>${rule.prefix}</Prefix></Filter><Expiration><Days>${rule.days}</Days></Expiration>` +
        `<AbortIncompleteMultipartUpload><DaysAfterInitiation>1</DaysAfterInitiation></AbortIncompleteMultipartUpload>` +
        `</Rule></LifecycleConfiguration>`,
    );
    const response = await this.send("put lifecycle", "PUT", url, {
      body,
      headers: {
        "content-type": "application/xml",
        "content-md5": createHash("md5").update(body).digest("base64"),
      },
    });
    await response.body?.cancel();
    return "added";
  }

  /** A short-lived download link on the public endpoint, saved under `filename`. */
  presignDownload(key: string, options: { expiresSeconds: number; filename: string }): string {
    return presignGetUrl({
      url: this.objectUrl(key, this.config.publicEndpoint),
      region: this.config.region,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      expiresSeconds: options.expiresSeconds,
      query: {
        "response-content-disposition": `attachment; filename="${options.filename.replace(/["\\]/g, "")}"`,
      },
    });
  }
}

function signedHeaders(
  config: ObjectStorageConfig,
  method: string,
  url: URL,
  body: Buffer | undefined,
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const signed = signV4({
    method,
    url,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    ...(body ? { body } : {}),
    ...(headers ? { headers } : {}),
  });
  // fetch sets Host itself.
  const { host: _host, ...rest } = signed;
  return rest;
}
