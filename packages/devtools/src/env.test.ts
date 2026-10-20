// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ALL_KEYS,
  ensureEnvLocal,
  expand,
  missingEnvLines,
  parseEnv,
  upgradeEnvText,
} from "./env.ts";
import { envExampleFile } from "./paths.ts";

describe("parseEnv", () => {
  it("parses keys, ignores comments and strips quotes", () => {
    const env = parseEnv("# comment\nA=1\nexport B=\"two words\"\nC='x'\n\nbad line\nD=a=b");
    expect([...env]).toEqual([
      ["A", "1"],
      ["B", "two words"],
      ["C", "x"],
      ["D", "a=b"],
    ]);
  });
});

describe("expand", () => {
  it("replaces known ${VAR} references and keeps unknown ones", () => {
    expect(expand("x-${A}-${B}", new Map([["A", "1"]]))).toBe("x-1-${B}");
  });
});

describe("missingEnvLines", () => {
  it("generates every key with secrets in the expected formats", () => {
    const env = parseEnv(missingEnvLines(new Map()).join("\n"));
    expect([...env.keys()]).toEqual(ALL_KEYS);
    expect(env.get("ZITADEL_MASTERKEY")).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(env.get("S3_ACCESS_KEY_ID")).toMatch(/^GK[0-9a-f]{24}$/);
    expect(env.get("S3_SECRET_ACCESS_KEY")).toMatch(/^[0-9a-f]{64}$/);
    expect(env.get("GARAGE_RPC_SECRET")).toMatch(/^[0-9a-f]{64}$/);
    expect(env.get("ZITADEL_ADMIN_PASSWORD")).toMatch(/[A-Z]/);
    expect(env.get("ZITADEL_ADMIN_PASSWORD")).toMatch(/[0-9]/);
    expect(env.get("ZITADEL_ADMIN_PASSWORD")).toMatch(/[^A-Za-z0-9]/);
    expect(env.get("DATABASE_ADMIN_URL")).toBe(
      `postgresql://postgres:${env.get("POSTGRES_PASSWORD")}@127.0.0.1:5432/clubadmin`,
    );
  });

  it("generates different secrets each time", () => {
    const a = parseEnv(missingEnvLines(new Map()).join("\n"));
    const b = parseEnv(missingEnvLines(new Map()).join("\n"));
    expect(a.get("POSTGRES_PASSWORD")).not.toBe(b.get("POSTGRES_PASSWORD"));
  });

  it("returns nothing when all keys exist", () => {
    const complete = new Map(ALL_KEYS.map((k) => [k, "x"]));
    expect(missingEnvLines(complete)).toEqual([]);
  });
});

describe("ensureEnvLocal", () => {
  it("creates the file, then only appends missing keys without changing existing values", () => {
    const file = join(mkdtempSync(join(tmpdir(), "clubadmin-env-")), ".env.local");
    expect(ensureEnvLocal(file)).toEqual(ALL_KEYS);

    const original = readFileSync(file, "utf8");
    const password = parseEnv(original).get("POSTGRES_PASSWORD");
    writeFileSync(file, original.replace(/^ZITADEL_MASTERKEY=.*\n/m, ""));

    expect(ensureEnvLocal(file)).toEqual(["ZITADEL_MASTERKEY"]);
    const updated = parseEnv(readFileSync(file, "utf8"));
    expect(updated.get("POSTGRES_PASSWORD")).toBe(password);
    expect(ensureEnvLocal(file)).toEqual([]);
  });
});

describe(".env.example", () => {
  it("documents every key that pnpm dev generates", () => {
    const example = parseEnv(readFileSync(envExampleFile, "utf8"));
    expect(ALL_KEYS.filter((key) => !example.has(key))).toEqual([]);
  });
});

describe("upgradeEnvText", () => {
  it("switches a DATABASE_URL that still points at the superuser to the app role", () => {
    const text = [
      "POSTGRES_PORT=5432",
      "POSTGRES_DB=clubadmin",
      "DB_APP_PASSWORD=apppw",
      "DATABASE_ADMIN_URL=postgresql://postgres:pw@127.0.0.1:5432/clubadmin",
      "DATABASE_URL=postgresql://postgres:pw@127.0.0.1:5432/clubadmin",
    ].join("\n");
    const { text: upgraded, upgraded: keys } = upgradeEnvText(text);
    expect(keys).toEqual(["DATABASE_URL"]);
    expect(parseEnv(upgraded).get("DATABASE_URL")).toBe(
      "postgresql://clubadmin_app:apppw@127.0.0.1:5432/clubadmin",
    );
    expect(upgradeEnvText(upgraded).upgraded).toEqual([]);
  });

  it("leaves a DATABASE_URL the developer changed alone", () => {
    const text = "DATABASE_ADMIN_URL=postgresql://a\nDATABASE_URL=postgresql://custom";
    expect(upgradeEnvText(text)).toEqual({ text, upgraded: [] });
  });
});
