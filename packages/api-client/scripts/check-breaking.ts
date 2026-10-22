// SPDX-License-Identifier: AGPL-3.0-only
// Fails on breaking changes to the API (ADR 0029): compares openapi.json with
// the version on the base ref using oasdiff (Apache-2.0), run at an exact
// version through Go's module proxy, so it stays out of the lockfile.
// Usage: pnpm api:breaking [baseRef]  (default: origin/main, or HEAD^ when
// HEAD is origin/main; CI passes the commit before the push).
// An intended break needs a line in breaking-changes-allowed.txt that names
// the ADR or issue deciding it.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Update deliberately: Go module versions also respect the 7-day rule (docs/licensing.md). */
const OASDIFF = "github.com/oasdiff/oasdiff@v1.33.0";
const SPEC = "packages/api-client/openapi.json";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(packageDir));
const allowedFile = join(packageDir, "breaking-changes-allowed.txt");
/**
 * oasdiff checks whose level ADR 0029 changes: new enum values in responses
 * are allowed (clients show a neutral fallback for values they do not know).
 */
const levelsFile = join(packageDir, "oasdiff-levels.txt");

const git = (...args: string[]) =>
  spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const rev = (ref: string) =>
  git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`).stdout.trim();

function baseRef(): string | null {
  const requested = process.argv[2] ?? process.env.OPENAPI_BASE_REF;
  if (requested && !/^0+$/.test(requested)) return rev(requested) ? requested : null;
  const main = rev("origin/main");
  if (!main) return null;
  return main === rev("HEAD") ? "HEAD^" : "origin/main";
}

/** Every exception must say which decision allows it. */
function checkAllowed(): string[] {
  const problems: string[] = [];
  const lines = readFileSync(allowedFile, "utf8").split("\n");
  lines.forEach((line, index) => {
    const text = line.trim();
    if (text === "" || text.startsWith("#")) return;
    if (!/\b(ADR \d{4}|#\d+)\b/.test(text)) {
      problems.push(`${allowedFile}:${index + 1}: name the ADR ("ADR 0029") or issue ("#12")`);
    }
  });
  return problems;
}

const problems = checkAllowed();
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}

const base = baseRef();
if (!base) {
  console.log("api:breaking: no base revision to compare with; skipped.");
  process.exit(0);
}
const old = git("show", `${base}:${SPEC}`);
if (old.status !== 0) {
  console.log(`api:breaking: ${SPEC} does not exist at ${base}; skipped.`);
  process.exit(0);
}
const baseFile = join(mkdtempSync(join(tmpdir(), "openapi-")), "base.json");
writeFileSync(baseFile, old.stdout);

const goCheck = spawnSync("go", ["version"], { encoding: "utf8" });
if (goCheck.error) {
  const message = "api:breaking needs Go (https://go.dev/dl/) to run oasdiff.";
  if (process.env.CI) {
    console.error(message);
    process.exit(1);
  }
  console.log(`${message} Skipped locally; CI runs it.`);
  process.exit(0);
}

console.log(`api:breaking: comparing ${SPEC} with ${base}`);
const result = spawnSync(
  "go",
  [
    "run",
    OASDIFF,
    "breaking",
    baseFile,
    join(repoRoot, SPEC),
    "--fail-on",
    "ERR",
    "--err-ignore",
    allowedFile,
    "--severity-levels",
    levelsFile,
  ],
  { cwd: repoRoot, stdio: "inherit", env: { ...process.env, GOTOOLCHAIN: "auto" } },
);
if (result.status !== 0) {
  console.error(
    "\nBreaking API change (ADR 0029). Add the new field or endpoint next to the old one and " +
      "deprecate the old one instead. If the break is intended and decided, add the line above " +
      "to packages/api-client/breaking-changes-allowed.txt with the ADR or issue.",
  );
}
process.exit(result.status ?? 1);
