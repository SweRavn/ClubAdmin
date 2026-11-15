// SPDX-License-Identifier: AGPL-3.0-only
// The signature page (P2.4 part C, ADR 0049 decision 6): when everyone named
// has signed a governing document's version, the worker renders one PDF
// page with pdfkit (as invoices, P1.13): the document, the version, the
// SHA-256 of exactly the signed text and each signer with role, level and
// time; it is stored beside the version. A later change to the text no
// longer matches the hash. Names follow protected identity (ADR 0022):
// a protected signer is shown without a name. IDs only in logs.

import { type Database, sql, type Tx } from "@clubadmin/db";
import { type Locale, localeOf } from "@clubadmin/i18n";
import type { ObjectStorage } from "@clubadmin/server-kit/object-storage";
import { DOMAIN_EVENTS } from "@clubadmin/shared";
import type { Task } from "graphile-worker";
import PDFDocument from "pdfkit";

import { render } from "../mail.ts";
import { visibleName } from "../presenters/mail-names.ts";

export interface SignaturePageInput {
  clubName: string;
  documentName: string;
  versionNumber: number;
  sha256: string;
  timeZone: string;
  signers: { name: string | null; role: string; signedAt: Date; level: string; provider: string }[];
}

const label = (locale: Locale, key: string, values: Record<string, string> = {}) =>
  render(locale, key, values, "signaturePage.");

/** The page as a PDF. */
export function renderSignaturePage(locale: Locale, page: SignaturePageInput): Promise<Buffer> {
  const pdf = new PDFDocument({ size: "A4", margin: 56, info: { Title: page.documentName } });
  const chunks: Buffer[] = [];
  pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) =>
    pdf.on("end", () => resolve(Buffer.concat(chunks))),
  );
  const when = (d: Date) =>
    new Intl.DateTimeFormat(locale, {
      timeZone: page.timeZone,
      dateStyle: "long",
      timeStyle: "medium",
    }).format(d);
  pdf.fontSize(18).text(label(locale, "title"));
  pdf.moveDown(0.5).fontSize(11).text(page.clubName);
  pdf.moveDown().fontSize(12).text(`${page.documentName}`, { continued: false });
  pdf.fontSize(10).text(label(locale, "version", { number: String(page.versionNumber) }));
  pdf.moveDown().text(label(locale, "hash"));
  pdf.font("Courier").fontSize(9).text(page.sha256);
  pdf.font("Helvetica").fontSize(10).moveDown();
  pdf.text(label(locale, "explanation"));
  pdf.moveDown();
  for (const s of page.signers) {
    pdf
      .fontSize(11)
      .text(s.name ?? label(locale, "hidden"))
      .fontSize(10)
      .text(
        label(locale, "signed", {
          role: label(locale, `roles.${s.role}`),
          at: when(s.signedAt),
          level: label(locale, `levels.${s.level}`),
          provider: s.provider,
        }),
      )
      .moveDown(0.5);
  }
  pdf.end();
  return done;
}

async function pageInput(
  tx: Tx,
  clubId: string,
  versionId: string,
): Promise<{ input: SignaturePageInput; key: string; locale: Locale } | null> {
  const { rows } = await tx.execute<{
    club_name: string;
    locale: string;
    time_zone: string;
    document_id: string;
    document_name: string;
    number: number;
    sha256: string | null;
    page_key: string | null;
  }>(sql`
    SELECT c.name AS club_name, c.default_locale AS locale, c.time_zone, d.id AS document_id,
      d.name AS document_name, v.number, v.sha256, v.signature_page_object_key AS page_key
    FROM public.document_versions v
    JOIN public.documents d ON d.id = v.document_id
    JOIN public.clubs c ON c.id = v.club_id
    WHERE v.id = ${versionId}::uuid`);
  const row = rows[0];
  if (!row?.sha256 || row.page_key) return null;
  const { rows: signers } = await tx.execute<{
    signer_person_id: string;
    role: string;
    signed_at: string | null;
    level: string | null;
    provider: string | null;
  }>(sql`
    SELECT signer_person_id, role, signed_at::text, level, provider FROM public.document_signatures
    WHERE version_id = ${versionId}::uuid ORDER BY signed_at, id`);
  if (signers.length === 0 || signers.some((s) => !s.signed_at)) return null;
  const people = [];
  for (const s of signers) {
    people.push({
      name: await visibleName(tx, clubId, s.signer_person_id),
      role: s.role,
      signedAt: new Date(s.signed_at!),
      level: s.level ?? "simple",
      provider: s.provider ?? "in_app",
    });
  }
  return {
    key: `documents/${clubId}/${row.document_id}/${versionId}-signatures.pdf`,
    locale: localeOf(row.locale) ?? "sv",
    input: {
      clubName: row.club_name,
      documentName: row.document_name,
      versionNumber: row.number,
      sha256: row.sha256,
      timeZone: row.time_zone,
      signers: people,
    },
  };
}

/** Makes and stores a fully signed version's signature page; false when there is nothing to do. */
export async function makeSignaturePage(
  db: Database,
  storage: ObjectStorage,
  clubId: string,
  versionId: string,
): Promise<boolean> {
  const found = await db.withSystem("documents:signature_page", { clubId }, (tx) =>
    pageInput(tx, clubId, versionId),
  );
  if (!found) return false;
  const pdf = await renderSignaturePage(found.locale, found.input);
  await storage.putObject(found.key, pdf, "application/pdf");
  await db.withSystem("documents:signature_page", { clubId }, (tx) =>
    tx.execute(sql`
      UPDATE public.document_versions SET signature_page_object_key = ${found.key},
        signature_page_made_at = now()
      WHERE id = ${versionId}::uuid AND signature_page_object_key IS NULL`),
  );
  return true;
}

export function signaturePageTask(db: Database, storage: ObjectStorage | null): Task {
  return async (payload, helpers) => {
    const { clubId, versionId } = DOMAIN_EVENTS["document.signed"].parse(payload);
    if (!storage) {
      helpers.logger.warn("no object storage: signature page not made", { versionId });
      return;
    }
    const made = await makeSignaturePage(db, storage, clubId, versionId);
    helpers.logger.info("signature page", { clubId, versionId, made });
  };
}
