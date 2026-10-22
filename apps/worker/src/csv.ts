// SPDX-License-Identifier: AGPL-3.0-only
// CSV for spreadsheet programs (RFC 4180, UTF-8 with a byte order mark).
// Cells that a spreadsheet would run as a formula (starting with = + - @, or
// a tab or carriage return) get a leading apostrophe (OWASP, CSV injection).

export const UTF8_BOM = "﻿";

export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const csvRow = (cells: readonly (string | number | null | undefined)[]): string =>
  `${cells.map(csvCell).join(",")}\r\n`;
