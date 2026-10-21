// SPDX-License-Identifier: AGPL-3.0-only
// Counts the SQL statements this process sends while `fn` runs (performance
// budgets: queries per request, docs/performance.md). Transaction control
// (BEGIN with the context settings, COMMIT, ROLLBACK) is not counted.

import pg from "pg";

const CONTROL = /^\s*(BEGIN;\s*SELECT set_config|COMMIT\b|ROLLBACK\b)/i;

export async function countQueries<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; queries: number; statements: string[] }> {
  const statements: string[] = [];
  const prototype = pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
  const original = prototype.query;
  prototype.query = function (this: unknown, ...args: unknown[]) {
    const first = args[0];
    const text = typeof first === "string" ? first : (first as { text?: string } | null)?.text;
    if (text && !CONTROL.test(text)) statements.push(text);
    return original.apply(this, args);
  };
  try {
    const result = await fn();
    return { result, queries: statements.length, statements };
  } finally {
    prototype.query = original;
  }
}
