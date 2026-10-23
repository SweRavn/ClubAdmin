// SPDX-License-Identifier: AGPL-3.0-only
// CSV files of member imports (P1.3b): UTF-8 with or without BOM, or
// Windows-1252 (older spreadsheet exports); `,`, `;` or tab detected from the
// header line. Cells are plain text: nothing is ever evaluated (a leading
// `=` stays a character). Malformed files fail with a code, never a value.

export class CsvError extends Error {
  readonly code: "import_format_unsupported" | "import_file_too_large";

  constructor(code: CsvError["code"]) {
    super(code);
    this.name = "CsvError";
    this.code = code;
  }
}

/** UTF-8 if the bytes are valid UTF-8 (BOM removed), else Windows-1252. */
export function decodeCsv(bytes: Uint8Array): string {
  if (bytes.includes(0)) throw new CsvError("import_format_unsupported");
  try {
    // ignoreBOM: false removes a leading BOM.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/** The separator used most outside quotes in the first line. */
export function detectDelimiter(text: string): string {
  const counts = new Map<string, number>([
    [";", 0],
    [",", 0],
    ["\t", 0],
  ]);
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && counts.has(ch)) counts.set(ch, counts.get(ch)! + 1);
  }
  let best = ",";
  let max = 0;
  for (const [ch, n] of counts) {
    if (n > max) {
      best = ch;
      max = n;
    }
  }
  return best;
}

/**
 * Parses RFC 4180 CSV (quoted cells with "" escapes and line breaks) into
 * rows of trimmed cells; empty lines are left out. More rows than `maxRows`
 * (after the header) fail.
 */
export function parseCsv(text: string, options: { maxRows: number }): string[][] {
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  const endRow = () => {
    row.push(cell);
    cell = "";
    if (row.some((c) => c.trim() !== "")) {
      rows.push(row.map((c) => c.trim()));
      if (rows.length > options.maxRows + 1) throw new CsvError("import_file_too_large");
    }
    row = [];
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        cell += ch;
      }
      i++;
      continue;
    }
    if (ch === '"' && cell.trim() === "") {
      cell = "";
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" || ch === "\n") {
      endRow();
      if (ch === "\r" && text[i + 1] === "\n") i++;
    } else {
      cell += ch;
    }
    i++;
  }
  if (quoted) throw new CsvError("import_format_unsupported");
  if (cell !== "" || row.length > 0) endRow();
  if (rows.length < 2) throw new CsvError("import_format_unsupported");
  return rows;
}
