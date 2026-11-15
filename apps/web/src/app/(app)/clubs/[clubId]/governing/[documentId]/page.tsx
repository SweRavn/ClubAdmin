// SPDX-License-Identifier: AGPL-3.0-only
// A governing document (P2.4, ADR 0049): the text in force (the shared
// Markdown with its settings markers), status and what it superseded; for
// those who manage it the draft editor, the adoption (with MFA), archiving
// and naming signers; for a named signer the signing (MFA, the hash of the
// version). Editors, recorders and signers go through the PersonPresenter.
import { enumKey } from "@clubadmin/i18n";
import { DECISION_BODIES, type GoverningVersion, SIGNER_ROLES } from "@clubadmin/shared";
import { formatDateTime, personLabel } from "@clubadmin/ui";
import { getLocale, getTimeZone, getTranslations } from "next-intl/server";

import {
  ActionForm,
  buttonClass,
  inputClass,
  secondaryButtonClass,
} from "../../../../../../components/action-form.tsx";
import { FormError, Notice } from "../../../../../../components/form-error.tsx";
import { Markdown } from "../../../../../../components/markdown.tsx";
import { getAdultMembersIfAllowed, getGoverningDocument } from "../../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string; documentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props) {
  const { clubId, documentId } = await params;
  return { title: (await getGoverningDocument(clubId, documentId)).name };
}

export default async function GoverningDocumentPage({ params, searchParams }: Props) {
  const [{ clubId, documentId }, query] = await Promise.all([params, searchParams]);
  const [t, locale, timeZone, doc] = await Promise.all([
    getTranslations(),
    getLocale(),
    getTimeZone(),
    getGoverningDocument(clubId, documentId),
  ]);
  const members = doc.canManage ? await getAdultMembersIfAllowed(clubId) : null;
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone }).format(new Date());
  // A calendar day (YYYY-MM-DD), the same everywhere.
  const day = (iso: string) =>
    formatDateTime(`${iso}T12:00:00Z`, { locale, timeZone: "UTC", dateStyle: "medium" });
  const time = (iso: string) =>
    formatDateTime(iso, { locale, timeZone, dateStyle: "medium", timeStyle: "short" });
  const draft = doc.draft;

  const signing = (v: GoverningVersion) => (
    <section className="space-y-2" data-testid="signing">
      <h3 className="font-semibold">{t("governing.signers")}</h3>
      {v.signers.length === 0 ? (
        <p className="text-sm text-muted">{t("governing.noSigners")}</p>
      ) : (
        <ul className="space-y-1 text-sm" data-testid="signers">
          {v.signers.map((s) => (
            <li key={s.signatureId}>
              {s.person ? personLabel(s.person) : "–"} ·{" "}
              {t(enumKey("governing.signerRoles", s.role))} ·{" "}
              {s.signedAt
                ? t("governing.signedAt", { date: time(s.signedAt) })
                : t("governing.waiting")}
            </li>
          ))}
        </ul>
      )}
      {v.sha256 ? (
        <p className="break-all text-xs text-muted">{t("governing.hash", { hash: v.sha256 })}</p>
      ) : null}
      {v.signers.some((s) => s.mine) ? (
        <ActionForm action="governing-sign" testId="sign">
          <input type="hidden" name="clubId" value={clubId} />
          <input type="hidden" name="documentId" value={doc.id} />
          <input type="hidden" name="versionId" value={v.id} />
          <p className="mb-2 text-sm text-muted">{t("governing.signHelp")}</p>
          <button type="submit" className={buttonClass}>
            {t("governing.sign")}
          </button>
        </ActionForm>
      ) : null}
      {v.signaturePage ? (
        <a
          href={`/clubs/${clubId}/governing/${doc.id}/signature-page?version=${v.id}`}
          className="text-sm underline"
          data-testid="signature-page"
        >
          {t("governing.signaturePage")}
        </a>
      ) : null}
      {doc.canManage && members ? (
        <details>
          <summary className="cursor-pointer text-sm underline">
            {t("governing.saveSigners")}
          </summary>
          <ActionForm action="governing-signers" className="mt-2 space-y-2" testId="signers-form">
            <input type="hidden" name="clubId" value={clubId} />
            <input type="hidden" name="documentId" value={doc.id} />
            <input type="hidden" name="versionId" value={v.id} />
            {[
              ...v.signers.map((s) => ({ id: s.person?.id ?? "", role: s.role })),
              { id: "", role: "adjuster" },
            ]
              .slice(0, 10)
              .map((s, n) => (
                <div key={n} className="grid gap-2 sm:grid-cols-2">
                  <select name={`signer.${n}.personId`} defaultValue={s.id} className={inputClass}>
                    <option value="">{t("meetings.nobody")}</option>
                    {members.items.map((m) => (
                      <option key={m.person.id} value={m.person.id}>
                        {personLabel(m.person)}
                      </option>
                    ))}
                  </select>
                  <select name={`signer.${n}.role`} defaultValue={s.role} className={inputClass}>
                    {SIGNER_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {t(enumKey("governing.signerRoles", r))}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            <button type="submit" className={secondaryButtonClass}>
              {t("governing.saveSigners")}
            </button>
          </ActionForm>
        </details>
      ) : null}
    </section>
  );

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted">
          <a href={`/clubs/${clubId}/governing`} className="underline">
            {t("governing.title")}
          </a>{" "}
          · {doc.series.name}
        </p>
        <h1 className="text-2xl font-semibold">{doc.name}</h1>
        <p className="mt-1 text-sm" data-testid="governing-status">
          {t(enumKey("governing.statuses", doc.status))}
        </p>
        {doc.supersededBy ? (
          <p className="text-sm">
            <a href={`/clubs/${clubId}/governing/${doc.supersededBy.id}`} className="underline">
              {t("governing.supersededBy", { name: doc.supersededBy.name })}
            </a>
          </p>
        ) : null}
        {doc.supersedes.length > 0 ? (
          <p className="text-sm text-muted">
            {t("governing.supersedesList", { names: doc.supersedes.map((d) => d.name).join(", ") })}
          </p>
        ) : null}
      </div>
      <FormError code={query.error} />
      {query.saved || query.created || query.assembled ? (
        <Notice>{t("governing.saved")}</Notice>
      ) : null}
      {query.adopted ? <Notice>{t("governing.adoptedNotice")}</Notice> : null}
      {query.signed ? <Notice>{t("governing.signedNotice")}</Notice> : null}

      <section className="space-y-3" data-testid="current">
        <h2 className="text-lg font-semibold">{t("governing.current")}</h2>
        {doc.current ? (
          <>
            {doc.current.adoption ? (
              <p className="text-sm text-muted">
                {t("governing.adoptedInfo", {
                  date: day(doc.current.adoption.adoptedOn),
                  from: day(doc.current.adoption.effectiveFrom),
                })}
              </p>
            ) : null}
            <Markdown source={doc.current.body} settings testId="current-text" />
            {signing(doc.current)}
          </>
        ) : (
          <p className="text-muted">{t("governing.noCurrent")}</p>
        )}
      </section>

      {draft ? (
        <section className="space-y-3" data-testid="draft">
          <h2 className="text-lg font-semibold">
            {t("governing.draft")} · {t("governing.version", { number: draft.number })}
          </h2>
          {doc.canManage ? (
            <ActionForm action="governing-save" className="space-y-2" testId="draft-editor">
              <input type="hidden" name="clubId" value={clubId} />
              <input type="hidden" name="documentId" value={doc.id} />
              <label className="block text-sm">
                {t("governing.documentName")}
                <input name="name" defaultValue={doc.name} maxLength={200} className={inputClass} />
              </label>
              <label className="block text-sm">
                {t("governing.body")}
                <textarea
                  name="body"
                  rows={16}
                  defaultValue={draft.body}
                  className={`${inputClass} font-mono text-sm`}
                />
                <span className="mt-1 block text-xs text-muted">{t("governing.bodyHelp")}</span>
              </label>
              <button type="submit" className={secondaryButtonClass}>
                {t("governing.save")}
              </button>
            </ActionForm>
          ) : (
            <Markdown source={draft.body} settings testId="draft-text" />
          )}
          {doc.canManage ? <Markdown source={draft.body} settings testId="draft-preview" /> : null}
          {signing(draft)}
          {doc.canAdopt ? (
            <ActionForm action="governing-adopt" className="space-y-2" testId="adopt">
              <h3 className="font-semibold">{t("governing.adopt")}</h3>
              <input type="hidden" name="clubId" value={clubId} />
              <input type="hidden" name="documentId" value={doc.id} />
              <input type="hidden" name="versionId" value={draft.id} />
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="block text-sm">
                  {t("governing.adoptedOn")}
                  <input
                    type="date"
                    name="adoptedOn"
                    required
                    defaultValue={today}
                    max={today}
                    className={inputClass}
                  />
                </label>
                <label className="block text-sm">
                  {t("governing.effectiveFrom")}
                  <input type="date" name="effectiveFrom" className={inputClass} />
                </label>
              </div>
              <label className="block text-sm">
                {t("governing.decisionBody")}
                <select name="decisionBody" className={inputClass} defaultValue="">
                  <option value="">–</option>
                  {DECISION_BODIES.map((b) => (
                    <option key={b} value={b}>
                      {t(enumKey("governing.decisionBodies", b))}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm">
                {t("governing.reference")}
                <input name="reference" maxLength={200} className={inputClass} />
              </label>
              <p className="text-xs text-muted">{t("governing.adoptHelp")}</p>
              <button type="submit" className={buttonClass}>
                {t("governing.adoptButton")}
              </button>
            </ActionForm>
          ) : null}
        </section>
      ) : null}

      {doc.versions.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">{t("governing.versions")}</h2>
          <ul className="space-y-1 text-sm" data-testid="versions">
            {doc.versions.map((v) => (
              <li key={v.id}>
                {t("governing.version", { number: v.number })} ·{" "}
                {v.adoption
                  ? t("governing.adoptedInfo", {
                      date: day(v.adoption.adoptedOn),
                      from: day(v.adoption.effectiveFrom),
                    })
                  : t("governing.notAdopted")}
                {v.editedBy ? ` · ${personLabel(v.editedBy)}` : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {doc.canManage ? (
        <div className="flex flex-wrap gap-2">
          {doc.status === "adopted" || doc.status === "superseded" ? (
            <ActionForm action="governing-archive" testId="archive">
              <input type="hidden" name="clubId" value={clubId} />
              <input type="hidden" name="documentId" value={doc.id} />
              <button type="submit" className={secondaryButtonClass}>
                {t("governing.archive")}
              </button>
            </ActionForm>
          ) : null}
          {doc.status === "draft" ? (
            <ActionForm action="governing-delete" testId="delete">
              <input type="hidden" name="clubId" value={clubId} />
              <input type="hidden" name="documentId" value={doc.id} />
              <input type="hidden" name="after" value={`/clubs/${clubId}/governing`} />
              <button type="submit" className={secondaryButtonClass}>
                {t("governing.delete")}
              </button>
            </ActionForm>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
