// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm dev:smoke`: end-to-end check that every backing service works, used
// locally and in CI after `pnpm dev:services`.

import { randomUUID } from "node:crypto";

import { exportCaddyRootCert } from "./caddy.ts";
import { composeCapture } from "./compose.ts";
import { loadEnv, requireEnv } from "./env.ts";
import { httpsGet } from "./https.ts";
import { check, type CheckResult, printResults } from "./report.ts";
import { signV4 } from "./s3.ts";
import { sendMail } from "./smtp.ts";
import { readZitadelAdminPat, ZITADEL_PAT_PATH } from "./zitadel-pat.ts";

function exec(service: string, command: string[]): string {
  const result = composeCapture(["exec", "-T", service, ...command]);
  if (result.status !== 0) throw new Error(result.stderr.trim() || `exit ${result.status}`);
  return result.stdout.trim();
}

const httpsBase = (domain: string, port: string) =>
  port === "443" ? `https://${domain}` : `https://${domain}:${port}`;

export async function smoke(): Promise<boolean> {
  const env = loadEnv();
  const results: CheckResult[] = [];
  const httpsPort = env.get("CADDY_HTTPS_PORT") ?? "443";
  const appDomain = env.get("APP_DOMAIN") ?? "clubadmin.localhost";
  const authDomain = env.get("AUTH_DOMAIN") ?? "auth.clubadmin.localhost";

  results.push(
    await check("PostgreSQL: databases and pg_stat_statements", () => {
      const user = requireEnv(env, "POSTGRES_USER");
      const sql =
        "select (select count(*) from pg_database where datname in ('clubadmin','zitadel'))::text || ',' || " +
        "(select count(*) from pg_extension where extname = 'pg_stat_statements')::text";
      const out = exec("postgres", [
        "psql",
        "-U",
        user,
        "-d",
        requireEnv(env, "POSTGRES_DB"),
        "-tAc",
        sql,
      ]);
      if (out !== "2,1") throw new Error(`unexpected result "${out}" (expected "2,1")`);
      return undefined;
    }),
  );

  results.push(
    await check("PostgreSQL: roles and migrations", () => {
      const user = requireEnv(env, "POSTGRES_USER");
      const sql =
        "select (select count(*) from pg_roles where rolname like 'clubadmin\\_%')::text || ',' || " +
        "(select count(*) from app_meta.schema_migrations)::text";
      const out = exec("postgres", [
        "psql",
        "-U",
        user,
        "-d",
        requireEnv(env, "POSTGRES_DB"),
        "-tAc",
        sql,
      ]);
      const [roles, migrations] = out.split(",").map(Number);
      if (roles !== 4 || !migrations)
        throw new Error(`roles ${roles}, migrations ${migrations}: run pnpm dev:services`);
      return `${migrations} migration(s) applied`;
    }),
  );

  results.push(
    await check("Valkey: PING", () => {
      const out = exec("valkey", ["valkey-cli", "ping"]);
      if (out !== "PONG") throw new Error(`got "${out}"`);
      return undefined;
    }),
  );

  let ca = "";
  results.push(
    await check("Caddy: local CA exported to .local/caddy-root.crt", () => {
      ca = exportCaddyRootCert();
      return undefined;
    }),
  );

  results.push(
    await check(`Caddy: https://${appDomain} (placeholder or web app)`, async () => {
      const res = await httpsGet(`${httpsBase(appDomain, httpsPort)}/`, { ca });
      if (!res.body.includes("ClubAdmin"))
        throw new Error(`HTTP ${res.status} without expected content`);
      return `HTTP ${res.status}, certificate trusted`;
    }),
  );

  results.push(
    await check(`Zitadel: https://${authDomain} OpenID configuration`, async () => {
      const res = await httpsGet(
        `${httpsBase(authDomain, httpsPort)}/.well-known/openid-configuration`,
        { ca },
      );
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const issuer = (JSON.parse(res.body) as { issuer?: string }).issuer;
      const expected = httpsBase(authDomain, httpsPort);
      if (issuer !== expected) throw new Error(`issuer is ${issuer}, expected ${expected}`);
      return `issuer ${issuer}`;
    }),
  );

  results.push(
    await check("Zitadel: login UI", async () => {
      const res = await httpsGet(`${httpsBase(authDomain, httpsPort)}/ui/login/register`, { ca });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      return undefined;
    }),
  );

  results.push(
    await check("Zitadel: machine-user PAT in the bootstrap volume", () => {
      if (!readZitadelAdminPat()) throw new Error("empty");
      return ZITADEL_PAT_PATH;
    }),
  );

  results.push(
    await check("Mailpit: SMTP delivery", async () => {
      const subject = `ClubAdmin smoke test ${randomUUID()}`;
      await sendMail("127.0.0.1", Number(env.get("SMTP_PORT") ?? "1025"), {
        from: requireEnv(env, "MAIL_FROM_ADDRESS"),
        to: "smoke@clubadmin.test",
        subject,
        text: "Sent by pnpm dev:smoke.",
      });
      const uiPort = env.get("MAILPIT_UI_PORT") ?? "8025";
      const query = encodeURIComponent(`subject:"${subject}"`);
      for (let attempt = 0; attempt < 20; attempt++) {
        const res = await fetch(`http://127.0.0.1:${uiPort}/api/v1/search?query=${query}`);
        const data = (await res.json()) as { messages_count?: number };
        if ((data.messages_count ?? 0) > 0) return `visible at http://127.0.0.1:${uiPort}`;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error("message did not arrive in Mailpit");
    }),
  );

  for (const bucketKey of ["S3_BUCKET_FILES", "S3_BUCKET_BACKUPS"]) {
    const bucket = env.get(bucketKey) ?? "";
    results.push(
      await check(`Garage: write, read and delete in bucket ${bucket}`, async () => {
        const credentials = {
          region: requireEnv(env, "S3_REGION"),
          accessKeyId: requireEnv(env, "S3_ACCESS_KEY_ID"),
          secretAccessKey: requireEnv(env, "S3_SECRET_ACCESS_KEY"),
        };
        const url = new URL(
          `${requireEnv(env, "S3_ENDPOINT")}/${bucket}/smoke-test/${randomUUID()}.txt`,
        );
        const body = "ClubAdmin smoke test";
        const put = await fetch(url, {
          method: "PUT",
          body,
          headers: signV4({ method: "PUT", url, body, ...credentials }),
        });
        if (!put.ok) throw new Error(`PUT HTTP ${put.status}: ${await put.text()}`);
        const get = await fetch(url, { headers: signV4({ method: "GET", url, ...credentials }) });
        if ((await get.text()) !== body)
          throw new Error(`GET HTTP ${get.status} returned other content`);
        const del = await fetch(url, {
          method: "DELETE",
          headers: signV4({ method: "DELETE", url, ...credentials }),
        });
        if (!del.ok) throw new Error(`DELETE HTTP ${del.status}`);
        return undefined;
      }),
    );
  }

  return printResults("Smoke test of the local services", results);
}
