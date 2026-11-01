// SPDX-License-Identifier: AGPL-3.0-only
// The message namespaces metro-transformer.js leaves out of the app bundle
// must exist and must not be used by the app: a key from one of them would
// show as the bare key.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { catalogues } from "@clubadmin/i18n";

import webOnly from "./web-only-namespaces.json";

const SRC = join(__dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("web-only message namespaces", () => {
  it("are namespaces of the catalogues", () => {
    for (const namespace of webOnly) expect(Object.keys(catalogues.en)).toContain(namespace);
  });

  it("are not used by the app", () => {
    const used = sources(SRC).flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return webOnly
        .filter((namespace) =>
          new RegExp(`["'\`]${namespace}\\.|enumKey\\(\\s*["'\`]${namespace}["'\`]`).test(text),
        )
        .map((namespace) => `${namespace} in ${file.slice(SRC.length + 1)}`);
    });
    expect(used).toEqual([]);
  });
});
