// SPDX-License-Identifier: AGPL-3.0-only
// Console output for the devtools commands (these are CLI tools, so console is intended).

export type Status = "ok" | "warn" | "fail";

export interface CheckResult {
  name: string;
  status: Status;
  detail?: string;
  fix?: string;
}

const SYMBOL: Record<Status, string> = { ok: "✔", warn: "!", fail: "✖" };

export function printResults(title: string, results: readonly CheckResult[]): boolean {
  console.log(`\n${title}\n`);
  for (const r of results) {
    console.log(`  ${SYMBOL[r.status]} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    if (r.fix && r.status !== "ok") console.log(`      fix: ${r.fix}`);
  }
  const failed = results.filter((r) => r.status === "fail").length;
  const warned = results.filter((r) => r.status === "warn").length;
  console.log(
    `\n  ${results.length - failed - warned} ok, ${warned} warning(s), ${failed} failure(s)\n`,
  );
  return failed === 0;
}

export async function check(
  name: string,
  fn: () => Promise<string | undefined> | string | undefined,
): Promise<CheckResult> {
  try {
    const detail = await fn();
    return detail === undefined ? { name, status: "ok" } : { name, status: "ok", detail };
  } catch (error) {
    return { name, status: "fail", detail: error instanceof Error ? error.message : String(error) };
  }
}
