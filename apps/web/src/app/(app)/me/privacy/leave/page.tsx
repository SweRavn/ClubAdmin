// SPDX-License-Identifier: AGPL-3.0-only
// Leaving a club (P1.8a): what ends, what the club keeps and for how long,
// and what must be settled first. Assignments (club roles, leader
// functions, group ownerships) are stepped down from here, one by one.

import { enumKey } from "@clubadmin/i18n";
import { getTranslations } from "next-intl/server";

import { ActionForm, buttonClass } from "../../../../../components/action-form.tsx";
import { FormError } from "../../../../../components/form-error.tsx";
import { getLeavePreview, requireId } from "../../../../../server/data.ts";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata() {
  return { title: (await getTranslations())("privacy.leaveTitle") };
}

const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : "");

const ENDS = {
  membership: "privacy.endsItems.membership",
  groups: "privacy.endsItems.groups",
  join_requests: "privacy.endsItems.join_requests",
  waiting_lists: "privacy.endsItems.waiting_lists",
  event_registrations: "privacy.endsItems.event_registrations",
  consents: "privacy.endsItems.consents",
} as const;

export default async function LeavePage({ searchParams }: Props) {
  const query = await searchParams;
  const clubId = requireId(one(query.clubId));
  const personId = one(query.personId) || null;
  const [t, preview] = await Promise.all([getTranslations(), getLeavePreview(clubId, personId)]);
  const back = `/me/privacy/leave?clubId=${clubId}&personId=${preview.personId}`;
  const assignments = preview.blockers.find((b) => b.code === "roles_must_be_removed");
  const invoices = preview.blockers.find((b) => b.code === "outstanding_invoices");
  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">
        {t("privacy.leaveHeading", { club: preview.clubName })}
      </h1>
      <FormError code={query.error} />
      <section className="space-y-2">
        <h2 className="font-semibold">{t("privacy.ends")}</h2>
        <ul className="list-inside list-disc text-sm">
          {preview.ends.map((e) => (
            <li key={e}>{t(ENDS[e])}</li>
          ))}
        </ul>
        <h2 className="font-semibold">{t("privacy.keeps")}</h2>
        <p className="text-sm">
          {t("privacy.keepsText", { months: preview.keeps.formerMemberRetentionMonths })}
        </p>
      </section>

      {assignments?.assignments?.length ? (
        <section
          className="space-y-2 rounded-lg border border-border bg-protected-soft p-4"
          data-testid="leave-assignments"
        >
          <h2 className="font-semibold">{t("privacy.assignmentsFirst")}</h2>
          <ul className="space-y-2">
            {assignments.assignments.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 text-sm">
                <span>
                  {a.kind === "role" && a.role
                    ? t(enumKey("roles", a.role))
                    : a.kind === "group_function" && a.function
                      ? t("privacy.functionIn", {
                          function: t(enumKey("functions", a.function)),
                          group: a.groupName ?? "",
                        })
                      : t("privacy.ownerOf", { group: a.groupName ?? "" })}
                </span>
                {a.blockedBy ? (
                  <span className="text-muted">{t(enumKey("joinErrors", a.blockedBy))}</span>
                ) : (
                  <ActionForm action="step-down" back={back}>
                    <input type="hidden" name="clubId" value={clubId} />
                    <input type="hidden" name="assignmentId" value={a.id} />
                    <input type="hidden" name="personId" value={preview.personId} />
                    <button
                      type="submit"
                      className="rounded-md border border-border px-3 py-1"
                      data-testid={`step-down-${a.id}`}
                    >
                      {t("privacy.stepDown")}
                    </button>
                  </ActionForm>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {invoices ? (
        <p className="rounded-md bg-protected-soft px-3 py-2" data-testid="leave-invoices">
          {t("privacy.invoicesFirst", {
            count: invoices.count ?? 1,
            role: invoices.contactRole ? t(enumKey("roles", invoices.contactRole)) : "",
          })}
        </p>
      ) : null}

      {preview.blockers.length === 0 ? (
        <ActionForm action="leave-club" className="space-y-3" testId="leave-form" back={back}>
          <input type="hidden" name="clubId" value={clubId} />
          <input type="hidden" name="personId" value={preview.personId} />
          <label className="flex items-start gap-2">
            <input type="checkbox" name="removeNow" />
            <span>
              <span className="block">{t("privacy.removeNow")}</span>
              <span className="block text-sm text-muted">{t("privacy.removeNowHint")}</span>
            </span>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="confirm" required data-testid="leave-confirm" />
            {t("privacy.leaveConfirm", { club: preview.clubName })}
          </label>
          <button type="submit" className={buttonClass} data-testid="leave-submit">
            {t("privacy.leaveButton")}
          </button>
        </ActionForm>
      ) : null}
    </div>
  );
}
