// SPDX-License-Identifier: AGPL-3.0-only
// Pure logic for the licence check (scripts/check-licenses.ts). See docs/licensing.md.

export type Mode = "default" | "mobile";

export interface LicenseException {
  reason: string;
  adr: string;
}

export interface LicensePolicy {
  allowed: string[];
  mobileAllowed: string[];
  exceptions: Record<string, LicenseException>;
}

export interface PackageLicense {
  name: string;
  versions: string[];
  license: string;
}

export interface Violation extends PackageLicense {
  reason: string;
}

interface PnpmLicenseEntry {
  name?: unknown;
  versions?: unknown;
  version?: unknown;
  license?: unknown;
}

/** Flattens the output of `pnpm licenses list --json` (licence → packages). */
export function parsePnpmLicenses(json: unknown): PackageLicense[] {
  if (json === null || typeof json !== "object") {
    throw new Error("Unexpected output from `pnpm licenses list --json`");
  }
  const result: PackageLicense[] = [];
  for (const [groupLicense, entries] of Object.entries(json as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries as PnpmLicenseEntry[]) {
      const name = typeof entry.name === "string" ? entry.name : "(unknown package)";
      const versions = Array.isArray(entry.versions)
        ? entry.versions.filter((v): v is string => typeof v === "string")
        : typeof entry.version === "string"
          ? [entry.version]
          : [];
      const license = typeof entry.license === "string" ? entry.license : groupLicense;
      result.push({ name, versions, license });
    }
  }
  return result;
}

type Token = "(" | ")" | "AND" | "OR" | "WITH" | { id: string };

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  for (const raw of expression.replace(/([()])/g, " $1 ").split(/\s+/)) {
    if (raw === "") continue;
    if (raw === "(" || raw === ")") tokens.push(raw);
    else if (/^(AND|OR|WITH)$/i.test(raw)) tokens.push(raw.toUpperCase() as "AND" | "OR" | "WITH");
    else tokens.push({ id: raw });
  }
  return tokens;
}

/**
 * Evaluates an SPDX licence expression against an allow list.
 * `A OR B` is allowed if either side is; `A AND B` only if both are.
 * `X WITH exception` is judged on `X` alone (exceptions only add permissions).
 * Throws on expressions that cannot be parsed.
 */
export function isExpressionAllowed(expression: string, allowed: ReadonlySet<string>): boolean {
  const tokens = tokenize(expression.trim());
  let position = 0;

  const peek = (): Token | undefined => tokens[position];
  const next = (): Token | undefined => tokens[position++];

  function parseOr(): boolean {
    let value = parseAnd();
    while (peek() === "OR") {
      next();
      const right = parseAnd();
      value = value || right;
    }
    return value;
  }

  function parseAnd(): boolean {
    let value = parseAtom();
    while (peek() === "AND") {
      next();
      const right = parseAtom();
      value = value && right;
    }
    return value;
  }

  function parseAtom(): boolean {
    const token = next();
    if (token === "(") {
      const value = parseOr();
      if (next() !== ")") throw new Error(`Unbalanced parentheses in "${expression}"`);
      return value;
    }
    if (token === undefined || typeof token === "string") {
      throw new Error(`Cannot parse licence expression "${expression}"`);
    }
    if (peek() === "WITH") {
      next();
      const exception = next();
      if (exception === undefined || typeof exception === "string") {
        throw new Error(`Missing exception after WITH in "${expression}"`);
      }
    }
    return allowed.has(token.id);
  }

  if (tokens.length === 0) throw new Error("Empty licence expression");
  const result = parseOr();
  if (position !== tokens.length)
    throw new Error(`Cannot parse licence expression "${expression}"`);
  return result;
}

export interface FindViolationsOptions {
  /** Packages to skip, e.g. this repository's own workspace packages. */
  ignore?: (name: string) => boolean;
}

export function findViolations(
  packages: readonly PackageLicense[],
  policy: LicensePolicy,
  mode: Mode,
  options: FindViolationsOptions = {},
): Violation[] {
  const allowed = new Set(mode === "mobile" ? policy.mobileAllowed : policy.allowed);
  const violations: Violation[] = [];

  for (const pkg of packages) {
    if (options.ignore?.(pkg.name)) continue;
    const excepted = [pkg.name, ...pkg.versions.map((v) => `${pkg.name}@${v}`)].some(
      (key) => key in policy.exceptions,
    );
    if (excepted) continue;

    const license = pkg.license.trim();
    if (license === "" || /^(unknown|unlicensed|see license in .*)$/i.test(license)) {
      violations.push({ ...pkg, reason: "missing or unknown licence" });
      continue;
    }
    let ok: boolean;
    try {
      ok = isExpressionAllowed(license, allowed);
    } catch {
      violations.push({ ...pkg, reason: "licence is not a valid SPDX expression" });
      continue;
    }
    if (!ok) {
      violations.push({
        ...pkg,
        reason:
          mode === "mobile" ? "not allowed in the mobile app bundle" : "not on the allow list",
      });
    }
  }
  return violations.sort((a, b) => a.name.localeCompare(b.name));
}

export function formatViolations(violations: readonly Violation[]): string {
  const rows = violations.map((v) => [v.name, v.versions.join(", "), v.license, v.reason]);
  const header = ["Package", "Versions", "Licence", "Problem"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}
