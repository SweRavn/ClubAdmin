// SPDX-License-Identifier: AGPL-3.0-only
// Trygghet → Registerutdrag (P2.8, ADR 0051 decision 6): who needs a check
// and who has a valid one, missing, expiring and records nobody needs any
// more; ticking off a certificate a person shows (a second factor, nothing
// uploaded, never one's own); a request the club starts (Norway: the
// confirmation of purpose); the requirements (the plugin's, the club's
// stricter additions, duty types' categories). People through the presenter.
import { enumKey } from "@clubadmin/i18n";
import { personLabel, PersonName, RoleBadge } from "@clubadmin/ui";
import { forbidden } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import {
  ActionForm,
  buttonClass,
  inputClass,
  secondaryButtonClass,
} from "../../../../../../components/action-form.tsx";
import { FormError, Notice } from "../../../../../../components/form-error.tsx";
import {
  getBackgroundCheckOverview,
  getBackgroundCheckRequirements,
  getClub,
  getMyClubs,
} from "../../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const STATUSES = ["missing", "expiring", "valid", "to_delete"] as const;
const CATEGORIES = [
  "regular_contact_with_children",
  "alone_with_children",
  "overnight",
  "board",
] as const;

export async function generateMetadata() {
  return { title: (await getTranslations())("backgroundChecks.title") };
}

export default async function BackgroundChecksPage({ params, searchParams }: Props) {
  const [{ clubId }, query, t, locale] = await Promise.all([
    params,
    searchParams,
    getTranslations(),
    getLocale(),
  ]);
  const [club, mine] = await Promise.all([getClub(clubId), getMyClubs()]);
  const permissions = mine.clubs.find((c) => c.club.id === club.id)?.permissions ?? [];
  const manages = permissions.includes("club.background_checks.manage");
  const verifies = permissions.includes("club.background_checks.verify");
  if (!manages && !verifies) forbidden();
  const status = typeof query.status === "string" ? query.status : null;
  const cursor = typeof query.cursor === "string" ? query.cursor : null;
  const [overview, requirements] = await Promise.all([
    getBackgroundCheckOverview(club.id, status, cursor),
    manages ? getBackgroundCheckRequirements(club.id) : null,
  ]);
  const day = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(
      new Date(`${iso}T12:00:00Z`),
    );
  const back = `/clubs/${club.id}/safeguarding/background-checks${status ? `?status=${status}` : ""}`;
  const types = requirements?.types ?? [];
  const byRecord = overview.items.flatMap((i) => i.records);
  // What can be ticked off: the plugin's types (from the requirements, or the records seen).
  const typeOptions =
    types.length > 0
      ? types.map((x) => ({ value: `${x.pluginId}:${x.key}`, name: x.name }))
      : [...new Map(byRecord.map((r) => [`${r.pluginId}:${r.checkType}`, r.checkTypeName]))].map(
          ([value, name]) => ({ value, name }),
        );
  const clubRequested = types.filter((x) => x.initiator === "club");
  const people = overview.items.filter((i) => i.status !== "to_delete");

  return (
    <div className="space-y-6" data-testid="background-checks-page">
      <div className="space-y-1">
        <p className="text-sm text-muted">
          <a href={`/clubs/${club.id}`} className="underline">
            {club.name}
          </a>
          {permissions.includes("club.safeguarding.handle") ? (
            <>
              {" · "}
              <a href={`/clubs/${club.id}/safeguarding`} className="underline">
                {t("safeguarding.title")}
              </a>
            </>
          ) : null}
        </p>
        <h1 className="text-2xl font-semibold">{t("backgroundChecks.title")}</h1>
        <p className="max-w-prose text-sm text-muted">{t("backgroundChecks.intro")}</p>
      </div>
      <FormError code={query.error} />
      {typeof query.saved === "string" ? (
        <Notice>{t(enumKey("backgroundChecks.saved", query.saved))}</Notice>
      ) : null}
      {!overview.active ? (
        <p className="rounded-md bg-surface p-3" data-testid="background-checks-off">
          {t("backgroundChecks.off")}
        </p>
      ) : null}

      <nav className="flex flex-wrap gap-4 text-sm" aria-label={t("backgroundChecks.title")}>
        <a
          href={`/clubs/${club.id}/safeguarding/background-checks`}
          className={status === null ? "font-semibold" : "underline"}
        >
          {t("backgroundChecks.all")}
        </a>
        {STATUSES.map((s) => (
          <a
            key={s}
            href={`/clubs/${club.id}/safeguarding/background-checks?status=${s}`}
            className={status === s ? "font-semibold" : "underline"}
            data-testid={`background-checks-filter-${s}`}
          >
            {t(enumKey("backgroundChecks.statuses", s))}
          </a>
        ))}
      </nav>

      <section className="space-y-2">
        {overview.items.length === 0 ? (
          <p className="text-muted">{t("backgroundChecks.empty")}</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {overview.items.map((item) => (
              <li
                key={item.person.id}
                className="space-y-1 px-3 py-2"
                data-testid={`background-check-${item.person.id}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <PersonName person={item.person} protectedLabel={t("protected.tooltip")} />
                  <RoleBadge
                    tone={item.status === "valid" ? "neutral" : "accent"}
                    label={t(enumKey("backgroundChecks.statuses", item.status))}
                  />
                  {item.categories.map((c) => (
                    <span key={c} className="text-xs text-muted">
                      {t(enumKey("backgroundChecks.categories", c))}
                    </span>
                  ))}
                </div>
                {item.expiresOn ? (
                  <p className="text-sm">{t("backgroundChecks.validUntil", { date: day(item.expiresOn) })}</p>
                ) : null}
                {item.request ? (
                  <p className="text-sm text-muted">
                    {t("backgroundChecks.requested", { date: day(item.request.createdAt.slice(0, 10)) })}
                  </p>
                ) : null}
                {item.records.map((r) => (
                  <div key={r.id} className="flex flex-wrap items-center gap-2 text-sm text-muted">
                    <span>
                      {t("backgroundChecks.record", {
                        type: r.checkTypeName,
                        issued: day(r.issuedOn),
                        verified: day(r.verifiedOn),
                        method: t(enumKey("backgroundChecks.methods", r.method)),
                      })}
                    </span>
                    {r.verifiedBy ? (
                      <span>
                        {t("backgroundChecks.by")}{" "}
                        <PersonName person={r.verifiedBy} protectedLabel={t("protected.tooltip")} />
                      </span>
                    ) : null}
                    {manages ? (
                      <ActionForm action="background-check-delete" back={back} className="inline">
                        <input type="hidden" name="clubId" value={club.id} />
                        <input type="hidden" name="recordId" value={r.id} />
                        <button
                          type="submit"
                          className="underline"
                          data-testid={`background-check-delete-${r.id}`}
                        >
                          {t("backgroundChecks.delete")}
                        </button>
                      </ActionForm>
                    ) : null}
                  </div>
                ))}
                {manages && item.status === "missing" && !item.request
                  ? clubRequested.map((x) => (
                      <ActionForm
                        key={x.key}
                        action="background-check-request"
                        back={back}
                        className="inline"
                      >
                        <input type="hidden" name="clubId" value={club.id} />
                        <input type="hidden" name="personId" value={item.person.id} />
                        <input type="hidden" name="type" value={`${x.pluginId}:${x.key}`} />
                        <button type="submit" className={secondaryButtonClass}>
                          {t("backgroundChecks.request", { type: x.name })}
                        </button>
                      </ActionForm>
                    ))
                  : null}
              </li>
            ))}
          </ul>
        )}
        {overview.hiddenCount > 0 ? (
          <p className="text-sm text-muted">
            {t("backgroundChecks.hidden", { count: overview.hiddenCount })}
          </p>
        ) : null}
        {overview.nextCursor ? (
          <a
            href={`${back}${status ? "&" : "?"}cursor=${overview.nextCursor}`}
            className="text-sm underline"
          >
            {t("backgroundChecks.more")}
          </a>
        ) : null}
      </section>

      {verifies && overview.active ? (
        <section className="max-w-lg space-y-3" data-testid="background-check-record">
          <h2 className="text-lg font-semibold">{t("backgroundChecks.recordTitle")}</h2>
          <p className="text-sm text-muted">{t("backgroundChecks.recordIntro")}</p>
          <ActionForm action="background-check-record" back={back} className="space-y-3">
            <input type="hidden" name="clubId" value={club.id} />
            <label className="block space-y-1">
              <span className="font-medium">{t("backgroundChecks.person")}</span>
              <select name="personId" required className={inputClass} data-testid="record-person">
                <option value="">{t("backgroundChecks.choosePerson")}</option>
                {people.map((i) => (
                  <option key={i.person.id} value={i.person.id}>
                    {personLabel(i.person)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="font-medium">{t("backgroundChecks.type")}</span>
              <select name="type" required className={inputClass} data-testid="record-type">
                {typeOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="font-medium">{t("backgroundChecks.issuedOn")}</span>
              <input
                type="date"
                name="issuedOn"
                required
                className={inputClass}
                data-testid="record-issued"
              />
              <span className="text-xs text-muted">{t("backgroundChecks.issuedHint")}</span>
            </label>
            <fieldset className="space-y-1">
              <legend className="font-medium">{t("backgroundChecks.how")}</legend>
              {(["viewed", "digital_mailbox"] as const).map((m) => (
                <label key={m} className="flex items-center gap-2">
                  <input type="radio" name="method" value={m} defaultChecked={m === "viewed"} />
                  {t(enumKey("backgroundChecks.methods", m))}
                </label>
              ))}
            </fieldset>
            <p className="text-sm text-muted">{t("backgroundChecks.nothingKept")}</p>
            <button type="submit" className={buttonClass} data-testid="record-submit">
              {t("backgroundChecks.recordSubmit")}
            </button>
          </ActionForm>
        </section>
      ) : null}

      {requirements ? <Requirements clubId={club.id} back={back} requirements={requirements} /> : null}
    </div>
  );
}

async function Requirements({
  clubId,
  back,
  requirements,
}: {
  clubId: string;
  back: string;
  requirements: NonNullable<Awaited<ReturnType<typeof getBackgroundCheckRequirements>>>;
}) {
  const t = await getTranslations();
  const plugin = requirements.plugin;
  if (!plugin) {
    return <p className="text-muted">{t("backgroundChecks.noPlugin")}</p>;
  }
  const type = requirements.types[0];
  const pluginRequired = new Set(
    requirements.pluginRequirements.filter((r) => r.level === "required").map((r) => r.category),
  );
  const clubRequired = new Set(requirements.clubRequirements.map((r) => r.category));
  const months = requirements.clubRequirements.find((r) => r.recheckMonths !== null)?.recheckMonths;
  const roles = requirements.roles.filter((r) => r.category !== null);
  return (
    <section className="space-y-4" data-testid="background-check-requirements">
      <h2 className="text-lg font-semibold">{t("backgroundChecks.requirements")}</h2>
      <ul className="space-y-1 text-sm">
        {requirements.pluginRequirements.map((r) => (
          <li key={`${r.category}:${r.checkType}`}>
            <span className="font-medium">{t(enumKey("backgroundChecks.categories", r.category))}</span>
            {": "}
            {t(enumKey("backgroundChecks.levels", r.level))}
            <span className="block text-xs text-muted">{r.basis}</span>
          </li>
        ))}
      </ul>
      {type ? (
        <p className="text-sm text-muted">
          {type.maxAgeDaysWhenPresented
            ? t("backgroundChecks.maxAge", { name: type.name, days: type.maxAgeDaysWhenPresented })
            : type.name}
        </p>
      ) : null}
      <p className="text-sm">
        {roles.length > 0
          ? t("backgroundChecks.rolesNeeding", { roles: roles.map((r) => r.name).join(", ") })
          : t("backgroundChecks.noRoles")}{" "}
        <a href={`/clubs/${clubId}/roles`} className="underline">
          {t("backgroundChecks.editRoles")}
        </a>
      </p>
      {type ? (
        <ActionForm action="background-check-requirements" back={back} className="max-w-lg space-y-3">
          <input type="hidden" name="clubId" value={clubId} />
          <input type="hidden" name="pluginId" value={plugin.id} />
          <input type="hidden" name="checkType" value={type.key} />
          <fieldset className="space-y-1">
            <legend className="font-medium">{t("backgroundChecks.clubStricter")}</legend>
            {CATEGORIES.map((c) => (
              <label key={c} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  name={`require.${c}`}
                  defaultChecked={pluginRequired.has(c) || clubRequired.has(c)}
                  data-testid={`require-${c}`}
                />
                {t(enumKey("backgroundChecks.categories", c))}
                {pluginRequired.has(c) ? (
                  <span className="text-xs text-muted">{t("backgroundChecks.byPlugin")}</span>
                ) : null}
              </label>
            ))}
          </fieldset>
          <label className="block space-y-1">
            <span className="font-medium">{t("backgroundChecks.recheckMonths")}</span>
            <input
              type="number"
              name="recheckMonths"
              min={1}
              max={120}
              defaultValue={months ?? ""}
              className={`${inputClass} w-32`}
              data-testid="recheck-months"
            />
            <span className="block text-xs text-muted">
              {type.recheckMonths
                ? t("backgroundChecks.recheckPlugin", { months: type.recheckMonths })
                : t("backgroundChecks.recheckNone")}
            </span>
          </label>
          {requirements.dutyTypes.length > 0 ? (
            <fieldset className="space-y-2">
              <legend className="font-medium">{t("backgroundChecks.dutyTypes")}</legend>
              {requirements.dutyTypes.map((d) => (
                <label key={d.id} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="dutyTypeId" value={d.id} />
                  <span className="w-40">{d.name}</span>
                  <select
                    name={`dutyCategory.${d.id}`}
                    defaultValue={d.category ?? ""}
                    className={`${inputClass} w-auto`}
                  >
                    <option value="">
                      {d.childContact === "none"
                        ? t("backgroundChecks.noCheck")
                        : t("backgroundChecks.fromContact", {
                            category: t(
                              enumKey(
                                "backgroundChecks.categories",
                                d.childContact === "alone_with_children"
                                  ? "alone_with_children"
                                  : "regular_contact_with_children",
                              ),
                            ),
                          })}
                    </option>
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {t(enumKey("backgroundChecks.categories", c))}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </fieldset>
          ) : null}
          <button type="submit" className={secondaryButtonClass} data-testid="requirements-save">
            {t("backgroundChecks.saveRequirements")}
          </button>
        </ActionForm>
      ) : null}
    </section>
  );
}
