// SPDX-License-Identifier: AGPL-3.0-only
// Is the backup bucket immutable? Reads its object lock configuration and
// versioning (S3 API) with the backup credentials. Garage (development) has
// neither: "not available". docs/operations/backup-restore.md, "Immutability".

import { request } from "node:https";

import { signV4 } from "@clubadmin/devtools/s3";

import type { OpsEnv } from "./env.ts";
import { required } from "./env.ts";

export interface ObjectLockConfiguration {
  enabled: boolean;
  mode: "COMPLIANCE" | "GOVERNANCE" | null;
  days: number | null;
}

const tag = (xml: string, name: string) =>
  new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(xml)?.[1] ?? null;

export function parseObjectLock(xml: string): ObjectLockConfiguration {
  const mode = tag(xml, "Mode");
  const days = tag(xml, "Days");
  const years = tag(xml, "Years");
  return {
    enabled: tag(xml, "ObjectLockEnabled") === "Enabled",
    mode: mode === "COMPLIANCE" || mode === "GOVERNANCE" ? mode : null,
    days: days ? Number(days) : years ? Number(years) * 365 : null,
  };
}

export const parseVersioning = (xml: string): boolean => tag(xml, "Status") === "Enabled";

export type ObjectLockStatus = "active" | "insufficient" | "inactive" | "not-available" | "error";

export interface ObjectLockReport {
  status: ObjectLockStatus;
  detail: string;
}

/** The verdict for a bucket's configuration, against the backup retention in days. */
export function judgeObjectLock(
  lock: ObjectLockConfiguration | null,
  versioning: boolean,
  retentionDays: number,
): ObjectLockReport {
  if (!lock || !lock.enabled) {
    return {
      status: "inactive",
      detail: `object lock is not enabled on the backup bucket${versioning ? "" : "; versioning is off"}`,
    };
  }
  const problems: string[] = [];
  if (lock.mode !== "COMPLIANCE")
    problems.push(`default retention mode is ${lock.mode ?? "not set"}, not COMPLIANCE`);
  if ((lock.days ?? 0) < retentionDays) {
    problems.push(
      `default retention is ${lock.days ?? 0} days, less than the ${retentionDays} days backups are kept`,
    );
  }
  if (!versioning) problems.push("versioning is off");
  return problems.length > 0
    ? { status: "insufficient", detail: problems.join("; ") }
    : { status: "active", detail: `compliance mode, ${lock.days} days, versioning on` };
}

interface S3Response {
  status: number;
  body: string;
}

function s3Get(env: OpsEnv, query: string): Promise<S3Response> {
  const endpoint = required(env, "BACKUP_S3_ENDPOINT");
  const bucket = required(env, "BACKUP_S3_BUCKET");
  const pathStyle = env.get("BACKUP_S3_URI_STYLE") === "path";
  const host = pathStyle ? endpoint : `${bucket}.${endpoint}`;
  const url = new URL(`https://${host}${pathStyle ? `/${bucket}` : ""}/?${query}=`);
  // Development: *.localhost is Caddy on this machine.
  const local = url.hostname.endsWith(".localhost");
  const port = url.port
    ? Number(url.port)
    : local
      ? Number(env.get("CADDY_HTTPS_PORT") ?? 443)
      : 443;
  const headers = signV4({
    method: "GET",
    url,
    region: env.get("BACKUP_S3_REGION") ?? "us-east-1",
    accessKeyId: required(env, "BACKUP_S3_ACCESS_KEY_ID"),
    secretAccessKey: required(env, "BACKUP_S3_SECRET_ACCESS_KEY"),
  });
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: local ? "127.0.0.1" : url.hostname,
        port,
        servername: url.hostname,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers,
        rejectUnauthorized: env.get("BACKUP_S3_VERIFY_TLS") !== "false",
        timeout: 15_000,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

export async function checkObjectLock(env: OpsEnv): Promise<ObjectLockReport> {
  const retentionDays = Number(env.get("BACKUP_RETENTION_DAYS") ?? 35);
  let lock: S3Response;
  let versioning: S3Response;
  try {
    [lock, versioning] = await Promise.all([s3Get(env, "object-lock"), s3Get(env, "versioning")]);
  } catch (error) {
    return { status: "error", detail: `backup bucket not reachable: ${(error as Error).message}` };
  }
  if (lock.status === 501 || /NotImplemented/.test(lock.body)) {
    return {
      status: "not-available",
      detail: "the storage does not support object lock (Garage in development)",
    };
  }
  if (lock.status === 404 && /ObjectLockConfigurationNotFound/.test(lock.body)) {
    return judgeObjectLock(null, parseVersioning(versioning.body), retentionDays);
  }
  if (lock.status !== 200) {
    // Garage answers unknown sub-resources with a plain listing or an error.
    return {
      status:
        lock.status >= 400 && lock.status < 500 && !/AccessDenied/.test(lock.body)
          ? "not-available"
          : "error",
      detail: `object lock configuration: HTTP ${lock.status}${tag(lock.body, "Code") ? ` ${tag(lock.body, "Code")}` : ""}`,
    };
  }
  if (!/<ObjectLockConfiguration/.test(lock.body)) {
    return {
      status: "not-available",
      detail: "the storage does not report an object lock configuration",
    };
  }
  return judgeObjectLock(
    parseObjectLock(lock.body),
    parseVersioning(versioning.body),
    retentionDays,
  );
}
