// SPDX-License-Identifier: AGPL-3.0-only
// Importing members from a file (P1.3b): upload a CSV file, map its columns
// (suggested from the headers; a sample value per column), see what will
// happen to every row (new, possible duplicate in the club, error with the
// reason), skip rows or decide "same person" / "different person", confirm,
// follow the progress and read the report. Past imports are listed. Works
// without client JavaScript; while the file is read or the members are
// added the page reloads itself.

import { enumKey } from "@clubadmin/i18n";
import {
  MEMBER_IMPORT_GUARDIAN_FIELDS,
  MEMBER_IMPORT_MEMBER_FIELDS,
  MEMBER_IMPORT_ROW_STATUSES,
  type MemberImport,
  MEMBERSHIP_TYPES,
  parseImportTarget,
} from "@clubadmin/shared";
import { EmptyState, personLabel, RoleBadge } from "@clubadmin/ui";
import { forbidden } from "next/navigation";
import { getTranslations } from "next-intl/server";

import {
  ActionForm,
  buttonClass,
  inputClass,
  secondaryButtonClass,
} from "../../../../../../components/action-form.tsx";
import { ClubTime } from "../../../../../../components/club-time.tsx";
import { FormError } from "../../../../../../components/form-error.tsx";
import {
  getClub,
  getMemberImport,
  getMemberImportRows,
  getMemberImports,
  getMyClubs,
  requireSession,
} from "../../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const PAGE_SIZE = 50;
const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : "");

export async function generateMetadata() {
  return { title: (await getTranslations())("memberImport.title") };
}

export default async function MemberImportPage({ params, searchParams }: Props) {
  const [{ clubId }, query] = await Promise.all([params, searchParams]);
  const [t, club, mine] = await Promise.all([getTranslations(), getClub(clubId), getMyClubs()]);
  const permissions = mine.clubs.find((c) => c.club.id === club.id)?.permissions ?? [];
  if (!permissions.includes("club.members.import")) forbidden();
  const importId = one(query.import);
  const imported = importId ? await getMemberImport(club.id, importId) : null;
  const list = importId ? null : await getMemberImports(club.id);
  const mfaMissing = importId ? imported === null : list === null;

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">
        <a href={`/clubs/${club.id}/members`} className="underline">
          {t("nav.members")}
        </a>
        {importId ? (
          <>
            {" / "}
            <a href={`/clubs/${club.id}/members/import`} className="underline">
              {t("memberImport.title")}
            </a>
          </>
        ) : null}
      </p>
      <h1 className="text-2xl font-semibold">{t("memberImport.title")}</h1>
      <FormError code={query.error} />
      {mfaMissing ? (
        <p role="alert" className="rounded-md bg-protected-soft px-3 py-2">
          {t("memberImport.mfa")}
        </p>
      ) : imported ? (
        <ImportView
          clubId={club.id}
          timeZone={club.timeZone}
          imported={imported}
          status={one(query.status)}
          cursor={one(query.cursor)}
        />
      ) : (
        <StartView clubId={club.id} timeZone={club.timeZone} imports={list?.items ?? []} />
      )}
    </div>
  );
}

async function StartView({
  clubId,
  timeZone,
  imports,
}: {
  clubId: string;
  timeZone: string;
  imports: readonly MemberImport[];
}) {
  const [t, session] = await Promise.all([getTranslations(), requireSession()]);
  return (
    <>
      <p>{t("memberImport.intro")}</p>
      <form
        method="post"
        action={`/clubs/${clubId}/members/import/upload`}
        encType="multipart/form-data"
        className="space-y-3 rounded-md border border-border p-4"
        data-testid="import-upload"
      >
        <input type="hidden" name="csrf" value={session.record.csrf} />
        <label className="block space-y-1">
          <span className="font-medium">{t("memberImport.file")}</span>
          <input
            type="file"
            name="file"
            accept=".csv,text/csv"
            required
            className="block"
            data-testid="import-file"
          />
        </label>
        <p className="text-sm text-muted">{t("memberImport.fileHint")}</p>
        <button type="submit" className={buttonClass} data-testid="import-upload-submit">
          {t("memberImport.upload")}
        </button>
      </form>

      <section aria-labelledby="imports-list" className="space-y-2">
        <h2 id="imports-list" className="text-lg font-semibold">
          {t("memberImport.list")}
        </h2>
        {imports.length === 0 ? (
          <EmptyState title={t("memberImport.empty")} headingLevel={3} />
        ) : (
          <ul className="divide-y divide-border" data-testid="imports">
            {imports.map((i) => (
              <li key={i.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                <a href={`/clubs/${clubId}/members/import?import=${i.id}`} className="underline">
                  <ClubTime value={i.createdAt} timeZone={timeZone} />
                </a>
                <span>
                  {i.createdBy ? personLabel(i.createdBy) : t("memberImport.byProtected")}
                </span>
                <RoleBadge label={t(enumKey("memberImport.status", i.status))} />
                <span className="text-sm text-muted">
                  {t("memberImport.listCounts", {
                    rows: i.counts.rows,
                    imported: i.counts.imported,
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

async function ImportView({
  clubId,
  timeZone,
  imported,
  status,
  cursor,
}: {
  clubId: string;
  timeZone: string;
  imported: MemberImport;
  status: string;
  cursor: string;
}) {
  const t = await getTranslations();
  const base = `/clubs/${clubId}/members/import?import=${imported.id}`;
  const working = imported.status === "parsing" || imported.status === "importing";
  const hidden = (
    <>
      <input type="hidden" name="clubId" value={clubId} />
      <input type="hidden" name="importId" value={imported.id} />
    </>
  );
  return (
    <div className="space-y-6" data-testid="import" data-status={imported.status}>
      {/* Reload while the file is read or the members are added (no JavaScript needed). */}
      {working ? <meta httpEquiv="refresh" content="3" /> : null}
      <div className="flex flex-wrap items-baseline gap-3">
        <RoleBadge label={t(enumKey("memberImport.status", imported.status))} tone="accent" />
        <span className="text-sm text-muted">
          <ClubTime value={imported.createdAt} timeZone={timeZone} />
        </span>
        {imported.detectedSource ? (
          <span className="text-sm">
            {t("memberImport.detected", { source: imported.detectedSource })}
          </span>
        ) : null}
      </div>
      {working ? (
        <p role="status" data-testid="import-working">
          {imported.status === "parsing" ? t("memberImport.parsing") : t("memberImport.importing")}
        </p>
      ) : null}
      {imported.errorCode ? (
        <p role="alert" className="rounded-md bg-protected-soft px-3 py-2">
          {enumKey("joinErrors", imported.errorCode) === "common.other"
            ? t("joinErrors.failed")
            : t(enumKey("joinErrors", imported.errorCode))}
        </p>
      ) : null}

      <Counts imported={imported} />

      {imported.status === "review" ? (
        <>
          <Mapping imported={imported} hidden={hidden} />
          <ActionForm action="confirm-import" className="space-y-2" testId="import-confirm">
            {hidden}
            <p className="font-medium" data-testid="import-summary">
              {t("memberImport.summary", {
                members: imported.counts.new,
                guardians: imported.counts.guardians,
                invitations: imported.counts.invitations,
              })}
            </p>
            {imported.counts.duplicate > 0 ? (
              <p className="text-sm">
                {t("memberImport.unresolved", { count: imported.counts.duplicate })}
              </p>
            ) : null}
            <button
              type="submit"
              className={buttonClass}
              disabled={imported.counts.new === 0}
              data-testid="import-confirm-submit"
            >
              {t("memberImport.confirm")}
            </button>
          </ActionForm>
        </>
      ) : null}
      {["uploaded", "parsing", "review", "failed"].includes(imported.status) ? (
        <ActionForm action="cancel-import" testId="import-cancel">
          {hidden}
          <button type="submit" className={secondaryButtonClass}>
            {t("memberImport.cancel")}
          </button>
        </ActionForm>
      ) : null}
      {imported.status === "done" ? (
        <p>
          <a href={`/clubs/${clubId}/members`} className="text-accent underline">
            {t("memberImport.toRegister")}
          </a>
        </p>
      ) : null}

      {imported.columns.length > 0 && !working ? (
        <Rows
          clubId={clubId}
          imported={imported}
          base={base}
          status={status}
          cursor={cursor}
          hidden={hidden}
        />
      ) : null}
    </div>
  );
}

async function Counts({ imported }: { imported: MemberImport }) {
  const t = await getTranslations();
  const c = imported.counts;
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="import-counts">
      {(
        [
          ["rows", c.rows],
          ["new", c.new],
          ["duplicate", c.duplicate],
          ["error", c.error],
          ["skipped", c.skipped],
          ["imported", c.imported],
          ["guardians", c.guardians],
          ["invitations", c.invitations],
        ] as const
      ).map(([key, value]) => (
        <div key={key} className="rounded-md border border-border p-2" data-count={key}>
          <dt className="text-xs text-muted">{t(enumKey("memberImport.counts", key))}</dt>
          <dd className="text-lg font-semibold">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

async function Mapping({ imported, hidden }: { imported: MemberImport; hidden: React.ReactNode }) {
  const t = await getTranslations();
  const mapped = Object.values(imported.columnMap)
    .map(parseImportTarget)
    .flatMap((target) => (target?.kind === "guardian" ? [target.index] : []));
  const guardians = Math.max(4, ...mapped.map((n) => n + 1));
  const targetLabel = (target: string) => {
    const parsed = parseImportTarget(target);
    if (!parsed) return target;
    return parsed.kind === "member"
      ? t(enumKey("memberImport.fields", parsed.field))
      : t("memberImport.guardianField", {
          number: parsed.index,
          field: t(enumKey("memberImport.guardianFields", parsed.field)),
        });
  };
  const targets = [
    ...MEMBER_IMPORT_MEMBER_FIELDS,
    ...Array.from({ length: guardians }, (_, i) =>
      MEMBER_IMPORT_GUARDIAN_FIELDS.map((f) => `guardian.${i + 1}.${f}`),
    ).flat(),
  ];
  const o = imported.options;
  return (
    <details open={imported.counts.error > 0} className="rounded-md border border-border p-3">
      <summary className="cursor-pointer font-medium">{t("memberImport.mapping")}</summary>
      <ActionForm action="update-import-mapping" className="mt-3 space-y-4" testId="import-mapping">
        {hidden}
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left">
              <th className="py-1 pr-2">{t("memberImport.column")}</th>
              <th className="py-1 pr-2">{t("memberImport.sample")}</th>
              <th className="py-1">{t("memberImport.field")}</th>
            </tr>
          </thead>
          <tbody>
            {imported.columns.map((column) => (
              <tr key={column.index} className="border-t border-border">
                <td className="py-1 pr-2">{column.header}</td>
                <td className="py-1 pr-2 text-muted">{column.sample ?? ""}</td>
                <td className="py-1">
                  <select
                    name={`column.${column.index}`}
                    defaultValue={imported.columnMap[String(column.index)] ?? ""}
                    className={inputClass}
                    aria-label={column.header}
                  >
                    <option value="">{t("memberImport.ignore")}</option>
                    {targets.map((target) => (
                      <option key={target} value={target}>
                        {targetLabel(target)}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-2 font-medium">{t("memberImport.options")}</legend>
          <label className="block space-y-1">
            <span className="text-sm">{t("memberImport.defaultType")}</span>
            <select name="membershipType" defaultValue={o.membershipType} className={inputClass}>
              {MEMBERSHIP_TYPES.map((v) => (
                <option key={v} value={v}>
                  {t(enumKey("membershipTypes", v))}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-sm">{t("memberImport.defaultStart")}</span>
            <input
              type="date"
              name="startDate"
              defaultValue={o.startDate ?? ""}
              className={inputClass}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm">{t("memberImport.memberNumbers")}</span>
            <select name="memberNumbers" defaultValue={o.memberNumbers} className={inputClass}>
              <option value="assign">{t("memberImport.numbersAssign")}</option>
              <option value="keep">{t("memberImport.numbersKeep")}</option>
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-sm">{t("memberImport.consentNote")}</span>
            <input
              name="consentNote"
              defaultValue={o.consentNote ?? ""}
              maxLength={500}
              className={inputClass}
              data-testid="import-consent"
            />
            <span className="block text-xs text-muted">{t("memberImport.consentHint")}</span>
          </label>
          <label className="flex items-start gap-2 sm:col-span-2">
            <input
              type="checkbox"
              name="sendInvitations"
              defaultChecked={o.sendInvitations}
              className="mt-1"
              data-testid="import-invitations"
            />
            <span>{t("memberImport.sendInvitations")}</span>
          </label>
        </fieldset>
        <button type="submit" className={secondaryButtonClass} data-testid="import-mapping-submit">
          {t("memberImport.applyMapping")}
        </button>
      </ActionForm>
    </details>
  );
}

async function Rows({
  clubId,
  imported,
  base,
  status,
  cursor,
  hidden,
}: {
  clubId: string;
  imported: MemberImport;
  base: string;
  status: string;
  cursor: string;
  hidden: React.ReactNode;
}) {
  const t = await getTranslations();
  const filter = (MEMBER_IMPORT_ROW_STATUSES as readonly string[]).includes(status) ? status : "";
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (filter) params.set("status", filter);
  if (/^[0-9]+$/.test(cursor)) params.set("cursor", cursor);
  const page = await getMemberImportRows(clubId, imported.id, params.toString());
  const review = imported.status === "review";
  const link = (s: string) => `${base}${s ? `&status=${s}` : ""}`;
  return (
    <section aria-labelledby="import-rows" className="space-y-3">
      <h2 id="import-rows" className="text-lg font-semibold">
        {t("memberImport.rows")}
      </h2>
      <nav className="flex flex-wrap gap-3 text-sm" aria-label={t("memberImport.filter")}>
        {["", ...MEMBER_IMPORT_ROW_STATUSES].map((s) => (
          <a
            key={s || "all"}
            href={link(s)}
            aria-current={s === filter ? "page" : undefined}
            className={s === filter ? "font-semibold" : "underline"}
          >
            {s ? t(enumKey("memberImport.rowStatus", s)) : t("memberImport.all")}
          </a>
        ))}
      </nav>
      {page.items.length === 0 ? (
        <EmptyState title={t("memberImport.noRows")} headingLevel={3} />
      ) : (
        <ul className="divide-y divide-border" data-testid="import-rows">
          {page.items.map((row) => (
            <li
              key={row.rowNumber}
              className="space-y-1 py-2"
              data-testid="import-row"
              data-status={row.status}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-muted">
                  {t("memberImport.rowNumber", { number: row.rowNumber })}
                </span>
                <span className="font-medium">{row.name ?? t("memberImport.noName")}</span>
                {row.birthDate ? <span className="text-sm">{row.birthDate}</span> : null}
                <RoleBadge label={t(enumKey("memberImport.rowStatus", row.status))} />
                {row.protected ? <RoleBadge label={t("protected.tooltip")} /> : null}
                {row.guardianRow ? <RoleBadge label={t("memberImport.guardianRow")} /> : null}
              </div>
              {row.guardians.length > 0 ? (
                <p className="text-sm text-muted">
                  {t("memberImport.guardiansOf", {
                    guardians: row.guardians
                      .map(
                        (g) =>
                          `${g.name ?? t("memberImport.noName")} (${
                            g.kind ? t(enumKey("guardianKinds", g.kind)) : ""
                          }${g.invited ? `, ${t("memberImport.invited")}` : ""})`,
                      )
                      .join(", "),
                  })}
                </p>
              ) : null}
              {row.groups.length > 0 ? (
                <p className="text-sm text-muted">
                  {t("memberImport.groupsOf", { groups: row.groups.join(", ") })}
                </p>
              ) : null}
              {row.issues.length > 0 ? (
                <ul className="list-inside list-disc text-sm" data-testid="row-issues">
                  {row.issues.map((issue) => (
                    <li key={issue}>{t(enumKey("memberImport.issues", issue))}</li>
                  ))}
                </ul>
              ) : null}
              {row.match ? (
                <p className="text-sm">
                  {t("memberImport.match", { person: personLabel(row.match) })}
                  {row.resolution
                    ? ` (${t(enumKey("memberImport.resolution", row.resolution))})`
                    : ""}
                </p>
              ) : null}
              {review && !row.guardianRow ? (
                <div className="flex flex-wrap gap-2">
                  {row.match && row.status !== "error" ? (
                    <>
                      <RowAction hidden={hidden} row={row.rowNumber} action="same_person">
                        {t("memberImport.samePerson")}
                      </RowAction>
                      <RowAction hidden={hidden} row={row.rowNumber} action="different_person">
                        {t("memberImport.differentPerson")}
                      </RowAction>
                    </>
                  ) : null}
                  {row.status === "skipped" ? (
                    <RowAction hidden={hidden} row={row.rowNumber} action="unskip">
                      {t("memberImport.unskip")}
                    </RowAction>
                  ) : row.status !== "error" ? (
                    <RowAction hidden={hidden} row={row.rowNumber} action="skip">
                      {t("memberImport.skip")}
                    </RowAction>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {page.nextCursor !== null ? (
        <a href={`${link(filter)}&cursor=${page.nextCursor}`} className="underline">
          {t("memberImport.more")}
        </a>
      ) : null}
    </section>
  );
}

function RowAction({
  hidden,
  row,
  action,
  children,
}: {
  hidden: React.ReactNode;
  row: number;
  action: string;
  children: string;
}) {
  return (
    <ActionForm action="update-import-row">
      {hidden}
      <input type="hidden" name="rowNumber" value={row} />
      <input type="hidden" name="rowAction" value={action} />
      <button type="submit" className={secondaryButtonClass} data-testid={`row-${action}`}>
        {children}
      </button>
    </ActionForm>
  );
}
