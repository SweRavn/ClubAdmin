// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm dev` for a compiled server app (apps/api, apps/worker): builds once,
// then keeps SWC compiling in watch mode and restarts Node when dist/ changes.
// Run from the app's directory; uses the app's own `build` script.

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const cwd = process.cwd();
const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
  name: string;
  scripts?: Record<string, string>;
};
const build = manifest.scripts?.build;
if (!build) throw new Error(`${manifest.name} has no build script`);

// Initial build, so node has something to start.
const initial = spawnSync(build, { cwd, shell: true, stdio: "inherit" });
if (initial.status !== 0) process.exit(initial.status ?? 1);

const children = [
  spawn(`${build} --watch`, { cwd, shell: true, stdio: "inherit" }),
  spawn(
    process.execPath,
    [
      "--watch-path=./dist",
      "--enable-source-maps",
      "--import",
      "./dist/instrumentation.js",
      "./dist/main.js",
    ],
    { cwd, stdio: "inherit" },
  ),
];

const stop = () => {
  for (const child of children) child.kill("SIGTERM");
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
for (const child of children) {
  child.on("exit", (code) => {
    stop();
    process.exitCode = code ?? 0;
  });
}
