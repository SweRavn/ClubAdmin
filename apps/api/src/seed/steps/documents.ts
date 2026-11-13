// SPDX-License-Identifier: AGPL-3.0-only
// Demo documents (P2.2, ADR 0049, docs/seed-data.md), in IK Norrbacka:
// - Göran (club manager) keeps the club's folder "Policyer" for the whole
//   club: the code of conduct and the traffic policy, which is public;
// - Erik (F2015's assistant coach) keeps F2015's "Matchschema" with the
//   spring schedule in two versions;
// - Erik's spring cup (an F2015 match) has the cup's information attached,
//   uploaded to the notice (the team's notices folder).
// Folders and audiences go through the documents service as the personas;
// the files are written as scanned and clean (the seed runs no worker), and
// stored in the object storage when the seed has one (S3_*), so that
// downloading works in the demo.

import { sql, type TenantContext } from "@clubadmin/db";

import type { DemoStep } from "../environment.ts";

/** A small valid PDF with one line of text (no personal data). */
function pdf(text: string): Buffer {
  const stream = `BT /F1 18 Tf 72 720 Td (${text.replace(/[()\\]/g, "")}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) body += `${String(o).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

export const documentsDemoStep: DemoStep = {
  name: "documents",
  async run(env, _data, core) {
    const id = (key: string) => {
      const found = core.ids.get(key);
      if (!found) throw new Error(`documents seed: unknown key ${key}`);
      return found;
    };
    const s = env.services;
    const clubId = id("ikn");
    const as = (persona: string): TenantContext => ({
      actorKind: "person",
      personId: id(persona),
      clubId,
      requestId: "seed:documents",
    });

    /** A file (its versions oldest first) as scanned and clean, stored when there is storage. */
    const file = async (
      persona: string,
      folderId: string,
      groupId: string | null,
      name: string,
      versions: string[],
    ): Promise<string> => {
      const documentId = await env.db.withTenant(as(persona), async (tx) => {
        const { rows } = await tx.execute<{ id: string }>(sql`
          INSERT INTO public.documents (club_id, folder_id, group_id, name, created_by_person_id)
          VALUES (${clubId}, ${folderId}, ${groupId}, ${name}, ${id(persona)}) RETURNING id`);
        const documentId = rows[0]!.id;
        let number = 0;
        for (const text of versions) {
          number++;
          const data = pdf(text);
          const { rows: version } = await tx.execute<{ id: string }>(sql`
            INSERT INTO public.document_versions (club_id, document_id, group_id, number, object_key,
              file_name, size, content_type, status, uploaded_by_person_id, uploaded_at, scanned_at)
            VALUES (${clubId}, ${documentId}, ${groupId}, ${number},
              'pending/' || ${documentId}::text || '/' || ${number}::text, ${name}, ${data.length},
              'application/pdf', 'clean', ${id(persona)}, now(), now())
            RETURNING id`);
          const versionId = version[0]!.id;
          const key = `documents/${clubId}/${documentId}/${versionId}`;
          await tx.execute(sql`
            UPDATE public.document_versions SET object_key = ${key} WHERE id = ${versionId}::uuid`);
          await tx.execute(sql`
            UPDATE public.documents SET current_version_id = ${versionId}, published_at = now()
            WHERE id = ${documentId}::uuid`);
          if (env.storage) await env.storage.putObject(key, data, "application/pdf");
        }
        return documentId;
      });
      return documentId;
    };

    // The club's policies (Göran, the club manager): one public.
    const policies = await s.documents.createFolder(
      as("goran"),
      { groupId: null },
      { name: "Policyer" },
    );
    await file("goran", policies, null, "Uppförandekod.pdf", [
      "IK Norrbacka - uppforandekod for spelare, ledare och foraldrar",
    ]);
    const traffic = await file("goran", policies, null, "Trafikpolicy.pdf", [
      "IK Norrbacka - trafikpolicy for resor till matcher och cuper",
    ]);
    await s.documents.updateDocument(as("goran"), traffic, { audience: [{ kind: "public" }] });

    // F2015's match schedule (Erik): two versions.
    const f2015 = id("ikn-f2015");
    const schedule = await s.documents.createFolder(
      as("erik"),
      { groupId: f2015 },
      { name: "Matchschema" },
    );
    await file("erik", schedule, f2015, "Matchschema vår.pdf", [
      "F2015 matchschema varen - forsta utkastet",
      "F2015 matchschema varen - med flyttad match mot Lit",
    ]);

    // The spring cup (an F2015 match) with the cup's information on its notice.
    const start = new Date(env.clock.now.getTime() + 10 * 86_400_000);
    start.setUTCHours(8, 0, 0, 0);
    const cup = await s.activities.createActivity(as("erik"), f2015, {
      kind: "match",
      title: "Vårcupen i Norrbacka",
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 6 * 3_600_000).toISOString(),
    });
    const notices = await s.documents.createFolder(
      as("erik"),
      { groupId: f2015 },
      { name: "Kallelser" },
    );
    await env.db.withTenant(as("erik"), (tx) =>
      tx.execute(
        sql`UPDATE public.document_folders SET purpose = 'notices' WHERE id = ${notices}::uuid`,
      ),
    );
    const info = await file("erik", notices, f2015, "Cupinfo Vårcupen.pdf", [
      "Varcupen i Norrbacka - samling 07.30, ta med matsack",
    ]);
    await s.documents.setNoticeAttachments(as("erik"), { activityId: cup.activity.id }, [info]);
  },
};
