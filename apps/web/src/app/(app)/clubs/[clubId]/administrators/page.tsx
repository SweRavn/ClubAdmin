// SPDX-License-Identifier: AGPL-3.0-only
// Administrators (P1.15 A3, ADR 0046): who administers the club, who counts
// towards the minimum of two and why not, the club's state, and the
// two-person rule for suspending an administrator: start (with a reason,
// optionally demoting to an ordinary member), confirm, cancel, and the
// target's recent role changes to review. Read with club.roles.read; acting
// needs club.roles.manage (or the chair, for confirming with two).
import { SUSPENSION_REVIEW_DAYS } from "@clubadmin/shared";
import { PersonName } from "@clubadmin/ui";
import { getLocale, getTranslations } from "next-intl/server";

import {
  ActionForm,
  buttonClass,
  inputClass,
  secondaryButtonClass,
} from "../../../../../components/action-form.tsx";
import { AdministratorsBanner } from "../../../../../components/administrators-banner.tsx";
import { FormError, Notice } from "../../../../../components/form-error.tsx";
import { roleName } from "../../../../../components/roles.ts";
import {
  getAdministrators,
  getClub,
  getClubRoles,
  getMe,
  getMyClubs,
  getSuspensionReview,
} from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const REASONS = ["compromised", "left_task", "other"] as const;

export async function generateMetadata() {
  return { title: (await getTranslations())("administrators.title") };
}

export default async function AdministratorsPage({ params, searchParams }: Props) {
  const [{ clubId }, query] = await Promise.all([params, searchParams]);
  const [t, locale, club, overview, roles, mine, me] = await Promise.all([
    getTranslations(),
    getLocale(),
    getClub(clubId),
    getAdministrators(clubId),
    getClubRoles(clubId),
    getMyClubs(),
    getMe(),
  ]);
  const permissions = mine.clubs.find((c) => c.club.id === club.id)?.permissions ?? [];
  const canManage = permissions.includes("club.roles.manage");
  const isChair = permissions.includes("club.managers.claim");
  const roleById = new Map(roles.items.map((r) => [r.id, r]));
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const back = `/clubs/${club.id}/administrators`;
  const reviews = canManage
    ? await Promise.all(overview.suspensions.map((s) => getSuspensionReview(club.id, s.id)))
    : [];
  const suspended = new Set(overview.suspensions.map((s) => s.target.id));
  // The review's period in the audit log: the last SUSPENSION_REVIEW_DAYS days.
  const reviewFrom = new Date(Date.now() - SUSPENSION_REVIEW_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);

  return (
    <div className="space-y-8" data-testid="administrators-page">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">{t("administrators.title")}</h1>
        <p>{t("administrators.intro")}</p>
        <a href={`/clubs/${club.id}/roles`} className="text-sm text-accent underline">
          {t("administrators.rolesLink")}
        </a>
      </div>
      <FormError code={query.error} />
      {typeof query.suspension === "string" ? (
        <Notice>{t(`administrators.done.${query.suspension}` as never)}</Notice>
      ) : null}
      <AdministratorsBanner clubId={club.id} overview={overview} />

      <section aria-labelledby="who" className="space-y-2">
        <h2 id="who" className="text-lg font-semibold">
          {t("administrators.who", { count: overview.count })}
        </h2>
        <p className="text-sm text-muted">{t("administrators.whoHint")}</p>
        <ul className="space-y-3" data-testid="administrators">
          {overview.items.map((a) => (
            <li
              key={a.person.id}
              className="space-y-2 rounded-lg border border-border bg-raised p-4"
              data-testid="administrator"
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <PersonName
                  person={a.person}
                  href={`/people/${a.person.id}?clubId=${club.id}`}
                  protectedLabel={t("protected.tooltip")}
                />
                <span className="text-sm text-muted">
                  {a.roleIds
                    .map((id) => roleById.get(id))
                    .filter((r) => r !== undefined)
                    .map((r) => roleName(t, locale, r))
                    .join(", ")}
                </span>
                <span
                  className={`ml-auto rounded px-2 text-xs ${a.counts ? "bg-accent-soft" : "bg-protected-soft"}`}
                >
                  {a.counts
                    ? t("administrators.counts")
                    : t(`administrators.notCounted.${a.reason ?? "no_account"}` as never)}
                </span>
              </div>
              {canManage && a.person.id !== me.personId && !suspended.has(a.person.id) ? (
                <details>
                  <summary className="cursor-pointer text-sm underline">
                    {t("administrators.suspend")}
                  </summary>
                  <ActionForm action="start-suspension" className="mt-2 grid max-w-xl gap-3">
                    <input type="hidden" name="clubId" value={club.id} />
                    <input type="hidden" name="personId" value={a.person.id} />
                    <input type="hidden" name="back" value={back} />
                    <p className="text-sm text-muted">{t("administrators.suspendHint")}</p>
                    <label className="flex flex-col gap-1 text-sm">
                      {t("administrators.reason")}
                      <select name="reason" className={inputClass} defaultValue="compromised">
                        {REASONS.map((r) => (
                          <option key={r} value={r}>
                            {t(`administrators.reasons.${r}`)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                      {t("administrators.note")}
                      <textarea name="note" maxLength={500} rows={2} className={inputClass} />
                    </label>
                    <label className="flex items-start gap-2 text-sm">
                      <input type="checkbox" name="demote" defaultChecked />
                      <span>{t("administrators.demote")}</span>
                    </label>
                    <button type="submit" className={buttonClass}>
                      {t("administrators.startSuspension")}
                    </button>
                  </ActionForm>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      {overview.suspensions.length > 0 ? (
        <section aria-labelledby="suspensions" className="space-y-2">
          <h2 id="suspensions" className="text-lg font-semibold">
            {t("administrators.openSuspensions")}
          </h2>
          <ul className="space-y-3" data-testid="suspensions">
            {overview.suspensions.map((s, i) => {
              const target = s.target.id === me.personId;
              const initiator = s.requestedBy.id === me.personId;
              const mayConfirm =
                !target && !initiator && (canManage || (isChair && overview.count === 2));
              const review = reviews[i];
              return (
                <li
                  key={s.id}
                  className="space-y-2 rounded-lg border-2 border-danger p-4"
                  data-testid="suspension"
                >
                  <p>
                    {t.rich("administrators.suspensionOf", {
                      target: () => (
                        <PersonName person={s.target} protectedLabel={t("protected.tooltip")} />
                      ),
                      by: () => (
                        <PersonName
                          person={s.requestedBy}
                          protectedLabel={t("protected.tooltip")}
                        />
                      ),
                    })}
                  </p>
                  <p className="text-sm">
                    {t(`administrators.reasons.${s.reason}`)}
                    {s.note ? ` — ${s.note}` : ""}
                  </p>
                  <p className="text-sm text-muted">
                    {t("administrators.expires", { date: date.format(new Date(s.expiresAt)) })}
                    {s.demote ? ` ${t("administrators.willDemote")}` : ""}
                  </p>
                  {s.reason === "compromised" ? (
                    <p className="text-sm">{t("administrators.compromisedHint")}</p>
                  ) : null}
                  {review && review.items.length > 0 ? (
                    <details>
                      <summary className="cursor-pointer text-sm underline">
                        {t("administrators.review", { count: review.items.length })}
                      </summary>
                      <ul className="mt-2 space-y-1 text-sm" data-testid="suspension-review">
                        {review.items.map((r) => (
                          <li key={`${r.occurredAt}:${r.action}:${r.resourceId ?? ""}`}>
                            {date.format(new Date(r.occurredAt))}: {r.action}
                          </li>
                        ))}
                      </ul>
                      <a
                        href={`/clubs/${club.id}/audit?actorId=${s.target.id}&from=${reviewFrom}`}
                        className="text-sm underline"
                      >
                        {t("administrators.reviewOpen")}
                      </a>
                    </details>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    {mayConfirm ? (
                      <ActionForm action="confirm-suspension">
                        <input type="hidden" name="clubId" value={club.id} />
                        <input type="hidden" name="suspensionId" value={s.id} />
                        <input type="hidden" name="back" value={back} />
                        <button type="submit" className={buttonClass}>
                          {t("administrators.confirm")}
                        </button>
                      </ActionForm>
                    ) : null}
                    {initiator ? (
                      <ActionForm action="cancel-suspension">
                        <input type="hidden" name="clubId" value={club.id} />
                        <input type="hidden" name="suspensionId" value={s.id} />
                        <input type="hidden" name="back" value={back} />
                        <button type="submit" className={secondaryButtonClass}>
                          {t("administrators.cancel")}
                        </button>
                      </ActionForm>
                    ) : null}
                    {target ? <p className="text-sm">{t("administrators.youAreTarget")}</p> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="how" className="space-y-2">
        <h2 id="how" className="text-lg font-semibold">
          {t("administrators.howTitle")}
        </h2>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>{t("administrators.howMinimum")}</li>
          <li>{t("administrators.howCounts")}</li>
          <li>{t("administrators.howThird")}</li>
          <li>{t("administrators.howSuspend")}</li>
          <li>{t("administrators.howAdd")}</li>
        </ul>
      </section>
    </div>
  );
}
