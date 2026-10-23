// SPDX-License-Identifier: AGPL-3.0-only
// Usage: pnpm commits:check [--dco] [--conventional] [--from <sha>] [--to <sha>]
// Checks every commit in from..to (default: origin/main..HEAD). If --from is
// empty or all zeros (a newly pushed branch), or not in this clone (the old
// head after a force push), only --to itself is checked.
// With neither --dco nor --conventional, both checks run.

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

import {
  checkConventional,
  checkSignOff,
  type Commit,
  GIT_LOG_FORMAT,
  parseGitLog,
} from "./commits.ts";

const { values } = parseArgs({
  options: {
    dco: { type: "boolean", default: false },
    conventional: { type: "boolean", default: false },
    from: { type: "string", default: "" },
    to: { type: "string", default: "HEAD" },
  },
});
const runAll = !values.dco && !values.conventional;
const checks: [string, (c: Commit) => string | null][] = [];
if (runAll || values.dco) checks.push(["DCO", checkSignOff]);
if (runAll || values.conventional) checks.push(["Conventional Commits", checkConventional]);

const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8" });

function defaultFrom(): string {
  try {
    return git(["rev-parse", "--verify", "--quiet", "origin/main"]).trim();
  } catch {
    return "";
  }
}

/** Whether the commit is in this clone (after a force push, the old head is not). */
function known(sha: string): boolean {
  try {
    git(["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

const from = values.from === "" ? defaultFrom() : values.from;
const newBranch = from === "" || /^0+$/.test(from);
if (!newBranch && !known(from)) {
  console.warn(`${from} is not in this clone (a force push?): checking ${values.to} only.`);
}
const rangeArgs = newBranch || !known(from) ? ["-1", values.to] : [`${from}..${values.to}`];
const commits = parseGitLog(git(["log", `--format=${GIT_LOG_FORMAT}`, ...rangeArgs]));

let failures = 0;
for (const commit of commits) {
  for (const [name, check] of checks) {
    const error = check(commit);
    if (error !== null) {
      failures++;
      console.error(`${commit.sha.slice(0, 10)} [${name}] ${error}`);
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} problem(s) in ${commits.length} commit(s). See CONTRIBUTING.md.`);
  process.exit(1);
}
console.log(
  `Commit checks passed for ${commits.length} commit(s): ${checks.map(([n]) => n).join(", ")}.`,
);
