// SPDX-License-Identifier: AGPL-3.0-only
// Pure logic for commit checks (scripts/check-commits.ts): DCO sign-off and
// Conventional Commits. See CONTRIBUTING.md.

export interface Commit {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  message: string;
}

const FIELD = "\x1f";
const RECORD = "\x1e";

/** The `git log --format` string that produces input for {@link parseGitLog}. */
export const GIT_LOG_FORMAT = ["%H", "%P", "%an", "%ae", "%B"].join("%x1f") + "%x1e";

export function parseGitLog(raw: string): Commit[] {
  return raw
    .split(RECORD)
    .map((record) => record.replace(/^\s+/, ""))
    .filter((record) => record.length > 0)
    .map((record) => {
      const [sha = "", parents = "", authorName = "", authorEmail = "", message = ""] =
        record.split(FIELD);
      return {
        sha,
        parents: parents.split(" ").filter(Boolean),
        authorName,
        authorEmail,
        message: message.trimEnd(),
      };
    });
}

export const isMergeCommit = (commit: Commit) => commit.parents.length > 1;

const SIGN_OFF = /^Signed-off-by:\s*(.+?)\s*<([^>]+)>\s*$/gm;

/** Returns an error message, or null when the commit carries a sign-off by its author. */
export function checkSignOff(commit: Commit): string | null {
  if (isMergeCommit(commit)) return null;
  const emails = [...commit.message.matchAll(SIGN_OFF)].map((m) => (m[2] ?? "").toLowerCase());
  if (emails.length === 0) {
    return "missing 'Signed-off-by:' line (commit with `git commit -s`)";
  }
  if (!emails.includes(commit.authorEmail.toLowerCase())) {
    return `no 'Signed-off-by:' line matches the author <${commit.authorEmail}>`;
  }
  return null;
}

const CONVENTIONAL =
  /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([a-z0-9][a-z0-9./-]*\))?!?: \S.*$/;

/** Returns an error message, or null when the subject follows Conventional Commits. */
export function checkConventional(commit: Commit): string | null {
  if (isMergeCommit(commit)) return null;
  const subject = commit.message.split("\n", 1)[0] ?? "";
  if (CONVENTIONAL.test(subject)) return null;
  return `subject "${subject}" is not a Conventional Commit, e.g. "feat(groups): add waiting list"`;
}
