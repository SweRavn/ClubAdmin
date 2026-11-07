// SPDX-License-Identifier: AGPL-3.0-only
// The invoice and credit note PDF (P1.13, ADR 0045): rendered with pdfkit
// from the invoice's own snapshots (seller and buyer at issue, its lines),
// so the document never changes when details change later; labels in the
// account's invoice language. No member's name is ever on it.

import { type Locale } from "@clubadmin/i18n";
import PDFDocument from "pdfkit";

import { render } from "./mail.ts";

export interface InvoiceDocument {
  kind: "invoice" | "credit_note";
  number: string;
  issuedAt: Date;
  dueAt: Date | null;
  currency: string;
  subtotalMinor: number;
  vatMinor: number;
  totalMinor: number;
  ocrReference: string | null;
  creditedNumber: string | null;
  seller: {
    name: string;
    organizationNumber: string;
    vatNumber: string | null;
    address: { street: string; postalCode: string; city: string; country: string };
    email: string | null;
    bankgiro: string;
    fTax: boolean;
  };
  buyer: {
    legalName: string;
    organizationNumber: string | null;
    vatNumber: string | null;
    address: { street?: string; postalCode?: string; city?: string; country?: string } | null;
    reference: string | null;
    vatNote: "none" | "reverse_charge" | "outside_scope";
  };
  lines: {
    description: string;
    periodStart: Date | null;
    periodEnd: Date | null;
    proration: boolean;
    quantity: number;
    amountMinor: number;
    vatRateBp: number;
  }[];
  vatByRate: { rateBp: number; baseMinor: number; vatMinor: number }[];
  timeZone: string;
}

const label = (locale: Locale, key: string, values: Record<string, string> = {}) =>
  render(locale, key, values, "billing.pdf.");

export function formatMoney(locale: Locale, minor: number, currency: string): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(minor / 100);
}

export function formatDate(locale: Locale, date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone }).format(date);
}

/** The period end is exclusive: shown as the day before. */
const lastDay = (end: Date) => new Date(end.getTime() - 1);

/** Renders the PDF; resolves with its bytes. */
export function renderInvoicePdf(doc: InvoiceDocument, locale: Locale): Promise<Buffer> {
  const pdf = new PDFDocument({
    size: "A4",
    margin: 50,
    info: {
      Title: `${label(locale, doc.kind === "invoice" ? "invoice" : "creditNote")} ${doc.number}`,
      Author: doc.seller.name,
      CreationDate: doc.issuedAt,
    },
  });
  const chunks: Buffer[] = [];
  pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
  });
  const money = (minor: number) => formatMoney(locale, minor, doc.currency);
  const date = (d: Date) => formatDate(locale, d, doc.timeZone);
  const left = 50;
  const right = 545;

  // Header: the document type and number, the seller.
  pdf
    .font("Helvetica-Bold")
    .fontSize(20)
    .text(label(locale, doc.kind === "invoice" ? "invoice" : "creditNote"), left, 50);
  pdf.font("Helvetica").fontSize(10);
  const facts: [string, string][] = [
    [label(locale, "number"), doc.number],
    [label(locale, "date"), date(doc.issuedAt)],
  ];
  if (doc.dueAt && doc.kind === "invoice") facts.push([label(locale, "due"), date(doc.dueAt)]);
  if (doc.creditedNumber) facts.push([label(locale, "credits"), doc.creditedNumber]);
  if (doc.buyer.reference) facts.push([label(locale, "reference"), doc.buyer.reference]);
  let y = 85;
  for (const [k, v] of facts) {
    pdf.font("Helvetica-Bold").text(k, 330, y, { width: 100 });
    pdf.font("Helvetica").text(v, 430, y, { width: 115 });
    y += 14;
  }

  const block = (title: string, lines: string[], x: number, top: number) => {
    pdf.font("Helvetica-Bold").fontSize(9).text(title.toUpperCase(), x, top);
    pdf.font("Helvetica").fontSize(10);
    let at = top + 13;
    for (const line of lines.filter(Boolean)) {
      pdf.text(line, x, at, { width: 240 });
      at += 13;
    }
    return at;
  };
  const s = doc.seller;
  const b = doc.buyer;
  const top = Math.max(y, 85) + 20;
  const sellerEnd = block(
    label(locale, "seller"),
    [
      s.name,
      s.address.street,
      `${s.address.postalCode} ${s.address.city}`,
      `${label(locale, "orgNumber")} ${s.organizationNumber}`,
      s.vatNumber ? `${label(locale, "vatNumber")} ${s.vatNumber}` : "",
      s.fTax ? label(locale, "fTax") : "",
      s.email ?? "",
    ],
    left,
    top,
  );
  const buyerEnd = block(
    label(locale, "buyer"),
    [
      b.legalName,
      b.address?.street ?? "",
      [b.address?.postalCode, b.address?.city].filter(Boolean).join(" "),
      b.address?.country && b.address.country !== s.address.country ? b.address.country : "",
      b.organizationNumber ? `${label(locale, "orgNumber")} ${b.organizationNumber}` : "",
      b.vatNumber ? `${label(locale, "vatNumber")} ${b.vatNumber}` : "",
    ],
    300,
    top,
  );

  // Lines.
  y = Math.max(sellerEnd, buyerEnd) + 25;
  const header = () => {
    pdf.font("Helvetica-Bold").fontSize(9);
    pdf.text(label(locale, "description"), left, y, { width: 230 });
    pdf.text(label(locale, "period"), 285, y, { width: 130 });
    pdf.text(label(locale, "vatRate"), 415, y, { width: 40, align: "right" });
    pdf.text(label(locale, "amount"), 455, y, { width: right - 455, align: "right" });
    y += 14;
    pdf.moveTo(left, y).lineTo(right, y).stroke();
    y += 6;
    pdf.font("Helvetica").fontSize(10);
  };
  header();
  for (const line of doc.lines) {
    if (y > 700) {
      pdf.addPage();
      y = 50;
      header();
    }
    const description = line.proration
      ? `${line.description} (${label(locale, "proration")})`
      : line.description;
    pdf.text(description, left, y, { width: 230 });
    pdf.text(
      line.periodStart && line.periodEnd
        ? `${date(line.periodStart)} – ${date(lastDay(line.periodEnd))}`
        : "",
      285,
      y,
      { width: 130 },
    );
    pdf.text(`${line.vatRateBp / 100} %`, 415, y, { width: 40, align: "right" });
    pdf.text(money(line.amountMinor), 455, y, { width: right - 455, align: "right" });
    y += 18;
  }

  // Totals and VAT per rate.
  pdf.moveTo(300, y).lineTo(right, y).stroke();
  y += 8;
  const total = (k: string, v: string, bold = false) => {
    pdf.font(bold ? "Helvetica-Bold" : "Helvetica").text(k, 300, y, { width: 150 });
    pdf.text(v, 455, y, { width: right - 455, align: "right" });
    y += 15;
  };
  total(label(locale, "subtotal"), money(doc.subtotalMinor));
  for (const rate of doc.vatByRate) {
    total(label(locale, "vat", { rate: String(rate.rateBp / 100) }), money(rate.vatMinor));
  }
  total(label(locale, "total"), money(doc.totalMinor), true);

  y += 10;
  pdf.font("Helvetica").fontSize(10);
  if (b.vatNote !== "none") {
    pdf.text(
      label(locale, b.vatNote === "reverse_charge" ? "reverseCharge" : "outsideScope"),
      left,
      y,
    );
    y += 16;
  }
  if (doc.kind === "invoice" && doc.ocrReference && doc.totalMinor > 0) {
    pdf.font("Helvetica-Bold").text(label(locale, "payment"), left, y);
    y += 14;
    pdf.font("Helvetica").text(
      label(locale, "pay", {
        bankgiro: s.bankgiro,
        ocr: doc.ocrReference,
        amount: money(doc.totalMinor),
        due: doc.dueAt ? date(doc.dueAt) : "",
      }),
      left,
      y,
      { width: right - left },
    );
  }
  pdf.end();
  return done;
}
