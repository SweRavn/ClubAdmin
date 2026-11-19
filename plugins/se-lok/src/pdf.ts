// SPDX-License-Identifier: AGPL-3.0-only
// A plain table as a PDF (pdfkit): a title, a few lines of facts and the
// rows. The creation date is the report's, so the same report gives the same
// file. Used for the report a registrar checks before registering it.

import PDFDocument from "pdfkit";

export interface TablePdf {
  title: string;
  facts: readonly string[];
  header: readonly string[];
  rows: readonly (readonly (string | number)[])[];
  createdAt: Date;
}

export function tablePdf(doc: TablePdf): Promise<Buffer> {
  const pdf = new PDFDocument({
    size: "A4",
    margin: 40,
    info: {
      Title: doc.title,
      Producer: "ClubAdmin",
      Creator: "ClubAdmin",
      CreationDate: doc.createdAt,
    },
  });
  const chunks: Buffer[] = [];
  pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
  });
  pdf.fontSize(16).text(doc.title);
  pdf.moveDown(0.5).fontSize(9);
  for (const fact of doc.facts) pdf.text(fact);
  pdf.moveDown();
  const width = (pdf.page.width - 80) / doc.header.length;
  const row = (cells: readonly (string | number)[], bold = false) => {
    if (pdf.y > pdf.page.height - 60) pdf.addPage();
    const y = pdf.y;
    pdf.font(bold ? "Helvetica-Bold" : "Helvetica");
    cells.forEach((cell, i) => pdf.text(String(cell), 40 + i * width, y, { width: width - 4 }));
    pdf.x = 40;
    pdf.moveDown(0.2);
  };
  row(doc.header, true);
  for (const r of doc.rows) row(r);
  pdf.end();
  return done;
}

/** A CSV cell: quoted when needed; text never read as a formula. */
export function csvCell(value: string | number): string {
  const text = String(value);
  const numeric = /^-?\d+(\.\d+)?$/.test(text);
  const safe = !numeric && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",;\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export const csv = (rows: readonly (readonly (string | number)[])[]) =>
  rows.map((r) => r.map(csvCell).join(";")).join("\r\n") + "\r\n";
