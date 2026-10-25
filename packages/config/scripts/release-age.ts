// SPDX-License-Identifier: AGPL-3.0-only
// The exceptions to the seven-day release age (pnpm-workspace.yaml,
// minimumReleaseAgeExclude): only fixes for critical vulnerabilities, one
// exact version per entry, under a comment with the advisory, "critical" and
// the date the version turns seven days old. After that date the entry must
// go (docs/security.md, "Dependencies").

export interface ReleaseAgeExclusion {
  entry: string;
  comment: string;
}

/** The entries of minimumReleaseAgeExclude with the comment line just above each. */
export function releaseAgeExclusions(workspaceYaml: string): ReleaseAgeExclusion[] {
  const lines = workspaceYaml.split(/\r?\n/);
  const start = lines.findIndex((l) => /^minimumReleaseAgeExclude:/.test(l));
  if (start === -1) return [];
  const inline = /^minimumReleaseAgeExclude:\s*\[(.*)\]\s*$/.exec(lines[start]!);
  if (inline) {
    return inline[1]!
      .split(",")
      .map((e) => e.trim().replace(/^["']|["']$/g, ""))
      .filter((e) => e !== "")
      .map((entry) => ({ entry, comment: "" }));
  }
  const result: ReleaseAgeExclusion[] = [];
  let comment = "";
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const c = /^\s*#\s?(.*)$/.exec(line);
    if (c) {
      comment = c[1]!;
      continue;
    }
    const item = /^\s*-\s*["']?([^"'\s]+)["']?\s*$/.exec(line);
    if (item) {
      result.push({ entry: item[1]!, comment });
      comment = "";
    }
  }
  return result;
}

const EXACT = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+@\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const ADVISORY = /\b(GHSA(-[23456789cfghjmpqrvwx]{4}){3}|CVE-\d{4}-\d{4,})\b/;
const UNTIL = /\buntil (\d{4}-\d{2}-\d{2})\b/;

/** Problems with the exclusions (empty when they follow the rule). */
export function releaseAgeProblems(workspaceYaml: string, today: string): string[] {
  const problems: string[] = [];
  for (const { entry, comment } of releaseAgeExclusions(workspaceYaml)) {
    if (!EXACT.test(entry)) {
      problems.push(`${entry}: name one exact version (name@1.2.3), not a package or a range`);
    }
    if (!ADVISORY.test(comment) || !/\bcritical\b/i.test(comment)) {
      problems.push(`${entry}: the comment above it must name the advisory and say "critical"`);
    }
    const until = UNTIL.exec(comment)?.[1];
    if (!until) {
      problems.push(`${entry}: the comment above it must say "until YYYY-MM-DD"`);
    } else if (until < today) {
      problems.push(`${entry}: older than seven days since ${until}; remove the exception`);
    }
  }
  return problems;
}
