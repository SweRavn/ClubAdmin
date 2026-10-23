// SPDX-License-Identifier: AGPL-3.0-only
// A call-up (#19, ADR 0036): the whole group, or only the members the
// leader picks. Only those called up have the activity in "My schedule",
// answer and are counted; the leaders take part as usual. Those who plan the
// activity change it; the other leaders see it. Works without client
// JavaScript (one form, radio buttons and checkboxes).
import { PersonName } from "@clubadmin/ui";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { ActionForm, buttonClass } from "../../../../../components/action-form.tsx";
import { ClubTime } from "../../../../../components/club-time.tsx";
import { FormError, Notice } from "../../../../../components/form-error.tsx";
import { getActivity, getInvitees } from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ activityId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("invitees.title") };
}

export default async function InviteesPage({ params, searchParams }: Props) {
  const [{ activityId }, query] = await Promise.all([params, searchParams]);
  const [t, activity, invitees] = await Promise.all([
    getTranslations(),
    getActivity(activityId),
    getInvitees(activityId),
  ]);
  if (!invitees) notFound();
  const open = activity.status === "scheduled" && Date.parse(activity.endsAt) > Date.now();
  const editable = activity.canManage && open;
  const protectedLabel = t("protected.tooltip");

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">
        <a href={`/activities/${activity.id}`} className="underline">
          {activity.title}
        </a>
        {" · "}
        <ClubTime
          value={activity.startsAt}
          timeZone={activity.timeZone}
          dateStyle="full"
          timeStyle="short"
        />
      </p>
      <h1 className="text-2xl font-semibold">{t("invitees.title")}</h1>
      {query.saved ? <Notice>{t("invitees.saved")}</Notice> : null}
      <FormError code={query.error} />
      {invitees.inviteesOnly ? (
        <p data-testid="invitees-count">{t("invitees.count", { count: invitees.invitedCount })}</p>
      ) : null}
      {!activity.canManage ? <p className="text-sm text-muted">{t("invitees.readOnly")}</p> : null}
      {activity.canManage && !open ? <p>{t("invitees.closed")}</p> : null}

      <ActionForm action="set-invitees" className="space-y-6" testId="invitees-form">
        <input type="hidden" name="activityId" value={activity.id} />
        <fieldset className="space-y-2">
          <legend className="sr-only">{t("invitees.title")}</legend>
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="inviteesOnly"
              value="whole"
              defaultChecked={!invitees.inviteesOnly}
              disabled={!editable}
              className="mt-1 h-5 w-5"
              data-testid="invitees-whole"
            />
            <span>
              {t("invitees.whole")}
              <span className="block text-sm text-muted">{t("invitees.wholeHint")}</span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="inviteesOnly"
              value="selected"
              defaultChecked={invitees.inviteesOnly}
              disabled={!editable}
              className="mt-1 h-5 w-5"
              data-testid="invitees-selected"
            />
            <span>
              {t("invitees.selected")}
              <span className="block text-sm text-muted">{t("invitees.selectedHint")}</span>
            </span>
          </label>
        </fieldset>

        <section aria-labelledby="invitees-players" className="space-y-2">
          <h2 id="invitees-players" className="text-lg font-semibold">
            {t("invitees.players")}
          </h2>
          {invitees.candidates.length === 0 ? (
            <p className="text-muted">{t("invitees.noCandidates")}</p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border bg-raised">
              {invitees.candidates.map((c) => (
                <li key={c.person.id} className="px-3 py-2">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      name="invite"
                      value={c.person.id}
                      defaultChecked={c.invited}
                      disabled={!editable}
                      className="h-5 w-5"
                      data-testid="invite"
                    />
                    <PersonName person={c.person} protectedLabel={protectedLabel} />
                  </label>
                </li>
              ))}
            </ul>
          )}
        </section>
        {editable ? (
          <button type="submit" className={buttonClass} data-testid="invitees-save">
            {t("invitees.save")}
          </button>
        ) : null}
      </ActionForm>
    </div>
  );
}
