// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { checkConventional, checkSignOff, type Commit, parseGitLog } from "./commits.ts";

const commit = (overrides: Partial<Commit>): Commit => ({
  sha: "abc123",
  parents: ["p1"],
  authorName: "Ada Lovelace",
  authorEmail: "ada@example.test",
  message: "feat(groups): add waiting list\n\nSigned-off-by: Ada Lovelace <ada@example.test>",
  ...overrides,
});

describe("checkSignOff", () => {
  it("accepts a sign-off by the author", () => {
    expect(checkSignOff(commit({}))).toBeNull();
  });

  it("accepts a sign-off with different email case", () => {
    expect(checkSignOff(commit({ authorEmail: "Ada@Example.test" }))).toBeNull();
  });

  it("rejects a commit without sign-off", () => {
    expect(checkSignOff(commit({ message: "feat: something" }))).toMatch(/missing/);
  });

  it("rejects a sign-off by someone else", () => {
    const message = "fix: x\n\nSigned-off-by: Someone Else <other@example.test>";
    expect(checkSignOff(commit({ message }))).toMatch(/matches the author/);
  });

  it("skips merge commits", () => {
    expect(checkSignOff(commit({ parents: ["p1", "p2"], message: "Merge" }))).toBeNull();
  });
});

describe("checkConventional", () => {
  it.each([
    "feat: add club switcher",
    "fix(api): handle empty body",
    "docs(adr): add 0023",
    "refactor!: rename groups",
    "chore(deps): update dependency vitest to v5",
  ])("accepts %s", (subject) => {
    expect(checkConventional(commit({ message: subject }))).toBeNull();
  });

  it.each(["Add club switcher", "feat:missing space", "feature: x", "fix(API): upper case scope"])(
    "rejects %s",
    (subject) => {
      expect(checkConventional(commit({ message: subject }))).not.toBeNull();
    },
  );
});

describe("parseGitLog", () => {
  it("parses records produced by GIT_LOG_FORMAT", () => {
    const raw =
      "sha1\x1fp1\x1fAda\x1fada@example.test\x1ffeat: one\n\nSigned-off-by: Ada <ada@example.test>\n\x1e\n" +
      "sha2\x1fp1 p2\x1fBob\x1fbob@example.test\x1fMerge branch\n\x1e";
    const commits = parseGitLog(raw);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({ sha: "sha1", authorEmail: "ada@example.test" });
    expect(commits[0]?.message).toBe("feat: one\n\nSigned-off-by: Ada <ada@example.test>");
    expect(commits[1]?.parents).toEqual(["p1", "p2"]);
  });
});
