// SPDX-License-Identifier: AGPL-3.0-only
// An activity (P1.4): when and where (with a map link), the leaders of its
// groups, notes; for those who manage it, leader notes and the forms to
// change, cancel, restore or delete it. A session of a series links to the
// series ("this and following"). Answers (P1.5): how many are coming, my
// family's answers with the buttons, who is coming where the viewer may see
// the group, and for leaders every answer with its note and "Take
// attendance". A call-up (#19) is linked for leaders and noted for everyone.
// Calendar data never lists participants.
import { enumKey } from "@clubadmin/i18n";
import { localDate, localTime } from "@clubadmin/shared";
import { personLabel, PersonName, RoleBadge } from "@clubadmin/ui";
import { getTranslations } from "next-intl/server";

import {
  ActionForm,
  buttonClass,
  inputClass,
  secondaryButtonClass,
} from "../../../../components/action-form.tsx";
import { ActivityFields } from "../../../../components/activity-fields.tsx";
import { ClubTime } from "../../../../components/club-time.tsx";
import { FormError, Notice } from "../../../../components/form-error.tsx";
import { ResponseButtons } from "../../../../components/response-buttons.tsx";
import {
  getActivity,
  getLocations,
  getResponseList,
  getResponseSummary,
} from "../../../../server/data.ts";

type Props = {
  params: Promise<{ activityId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props) {
  return { title: (await getActivity((await params).activityId)).title };
}

export default async function ActivityPage({ params, searchParams }: Props) {
  const [{ activityId }, query] = await Promise.all([params, searchParams]);
  const [t, activity, answers, list] = await Promise.all([
    getTranslations(),
    getActivity(activityId),
    getResponseSummary(activityId),
    getResponseList(activityId),
  ]);
  const locations = activity.canManage ? await getLocations(activity.clubId, true) : [];
  const asked = answers.responseMode !== "none";
  const zone = activity.timeZone;
  const start = new Date(activity.startsAt);
  const cancelled = activity.status === "cancelled";
  const protectedLabel = t("protected.tooltip");
  const location = activity.location;
  const address = location
    ? [location.street, [location.postalCode, location.city].filter(Boolean).join(" ")]
        .filter(Boolean)
        .join(", ")
    : null;

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">
        {activity.groups.map((g, i) => (
          <span key={g.id}>
            {i > 0 ? ", " : null}
            <a href={`/groups/${g.id}`} className="underline">
              {g.name}
            </a>
          </span>
        ))}
      </p>
      <h1
        className={`flex flex-wrap items-center gap-2 text-2xl font-semibold ${cancelled ? "line-through" : ""}`}
        data-testid="activity-heading"
      >
        {activity.title}
        <RoleBadge label={t(enumKey("activityKinds", activity.kind))} />
        {cancelled ? <RoleBadge tone="accent" label={t("activities.cancelled")} /> : null}
      </h1>
      {query.saved ? <Notice>{t("activities.saved")}</Notice> : null}
      {query.answered ? <Notice>{t("responses.saved")}</Notice> : null}
      {query.updated ? <Notice>{t("activities.updated")}</Notice> : null}
      <FormError code={query.error} />
      {cancelled ? (
        <p
          role="status"
          className="rounded-md bg-protected-soft px-3 py-2"
          data-testid="activity-cancelled"
        >
          {activity.cancelledReason
            ? t("activities.cancelledBecause", { reason: activity.cancelledReason })
            : t("activities.cancelledNoReason")}
        </p>
      ) : null}

      <dl
        className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2"
        data-testid="activity-details"
      >
        <dt className="text-muted">{t("activities.when")}</dt>
        <dd>
          {activity.allDay ? (
            <ClubTime value={activity.startsAt} timeZone={zone} dateStyle="full" />
          ) : (
            <>
              <ClubTime
                value={activity.startsAt}
                timeZone={zone}
                dateStyle="full"
                timeStyle="short"
              />
              {" – "}
              <ClubTime value={activity.endsAt} timeZone={zone} timeStyle="short" />
            </>
          )}
        </dd>
        {activity.meetAt || activity.meetPlace ? (
          <>
            <dt className="text-muted">{t("activities.meet")}</dt>
            <dd>
              {activity.meetAt ? (
                <ClubTime value={activity.meetAt} timeZone={zone} timeStyle="short" />
              ) : null}
              {activity.meetAt && activity.meetPlace ? ", " : null}
              {activity.meetPlace}
            </dd>
          </>
        ) : null}
        {location || activity.locationText ? (
          <>
            <dt className="text-muted">{t("activities.where")}</dt>
            <dd data-testid="activity-place">
              {location ? (
                <>
                  {location.name}
                  {address ? <span className="block text-sm text-muted">{address}</span> : null}
                  {location.directions ? (
                    <span className="block text-sm">{location.directions}</span>
                  ) : null}
                  {location.mapUrl ? (
                    <a
                      href={location.mapUrl}
                      className="text-sm text-accent underline"
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      {t("activities.map")}
                    </a>
                  ) : null}
                </>
              ) : (
                activity.locationText
              )}
            </dd>
          </>
        ) : null}
        {activity.opponent ? (
          <>
            <dt className="text-muted">{t("activities.opponent")}</dt>
            <dd>
              {activity.opponent}
              {activity.homeAway ? ` (${t(enumKey("homeAway", activity.homeAway))})` : null}
            </dd>
          </>
        ) : null}
        {activity.competition ? (
          <>
            <dt className="text-muted">{t("activities.competition")}</dt>
            <dd>{activity.competition}</dd>
          </>
        ) : null}
        {activity.notes ? (
          <>
            <dt className="text-muted">{t("activities.notes")}</dt>
            <dd className="whitespace-pre-line">{activity.notes}</dd>
          </>
        ) : null}
        {activity.leaderNotes ? (
          <>
            <dt className="text-muted">{t("activities.leaderNotes")}</dt>
            <dd className="whitespace-pre-line" data-testid="activity-leader-notes">
              {activity.leaderNotes}
            </dd>
          </>
        ) : null}
      </dl>

      {asked ? (
        <section aria-labelledby="activity-responses" className="space-y-3">
          <h2 id="activity-responses" className="text-lg font-semibold">
            {t("responses.title")}
          </h2>
          {activity.inviteesOnly ? (
            <p className="text-sm" data-testid="invitees-only">
              {t("invitees.onlyInvited")}
            </p>
          ) : null}
          <p data-testid="response-counts">{t("responses.counts", answers.counts)}</p>
          {answers.respondBy ? (
            <p className="text-sm text-muted">
              {t("responses.answerByLabel")}{" "}
              <ClubTime
                value={answers.respondBy}
                timeZone={zone}
                dateStyle="medium"
                timeStyle="short"
              />
            </p>
          ) : null}
          {answers.open && answers.deadlinePassed ? (
            <p className="text-sm">{t("responses.deadlinePassed")}</p>
          ) : null}
          {!answers.open && !cancelled ? <p className="text-sm">{t("responses.closed")}</p> : null}
          {answers.mine.length > 0 ? (
            <div className="space-y-3" data-testid="my-responses">
              {answers.mine.map((r) => (
                <div key={r.person.id} className="space-y-1 rounded-lg border border-border p-3">
                  <p className="text-sm">
                    <PersonName person={r.person} protectedLabel={protectedLabel} />
                    {r.status ? (
                      <>
                        {" · "}
                        <RoleBadge label={t(enumKey("responseStatus", r.status))} />
                      </>
                    ) : null}
                    {r.respondedBy && r.respondedBy.id !== r.person.id ? (
                      <span className="block text-xs text-muted">
                        {t("responses.answeredBy", { name: personLabel(r.respondedBy) })}
                      </span>
                    ) : null}
                  </p>
                  {r.canRespond ? (
                    <ResponseButtons
                      activityId={activity.id}
                      personId={r.person.id}
                      status={r.status}
                      deadlinePassed={answers.deadlinePassed}
                    />
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          {answers.attending && !list ? (
            answers.attending.length === 0 ? (
              <p className="text-muted">{t("responses.nobody")}</p>
            ) : (
              <div>
                <h3 className="text-sm font-semibold">{t("responses.attendingList")}</h3>
                <ul className="flex flex-wrap gap-2" data-testid="attending-list">
                  {answers.attending.map((p) => (
                    <li key={p.id} className="rounded-full bg-surface px-2 py-0.5 text-sm">
                      <PersonName person={p} protectedLabel={protectedLabel} />
                    </li>
                  ))}
                </ul>
              </div>
            )
          ) : null}
          {list ? (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">{t("responses.leadersList")}</h3>
              <ul
                className="divide-y divide-border rounded-lg border border-border"
                data-testid="response-list"
              >
                {list.items.map((r) => (
                  <li key={r.person.id} className="flex flex-wrap items-baseline gap-2 px-3 py-2">
                    <PersonName
                      person={r.person}
                      href={`/people/${r.person.id}?clubId=${activity.clubId}`}
                      protectedLabel={protectedLabel}
                    />
                    <RoleBadge
                      tone={r.status === "not_attending" ? "accent" : "neutral"}
                      label={
                        r.status
                          ? t(enumKey("responseStatus", r.status))
                          : t("responses.notAnswered")
                      }
                    />
                    {r.note ? <span className="text-sm text-muted">{r.note}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      {list || activity.canManage ? (
        <p className="flex flex-wrap gap-4">
          <a
            href={`/activities/${activity.id}/attendance`}
            className="text-accent underline"
            data-testid="take-attendance"
          >
            {t("attendance.take")}
          </a>
          {list ? (
            <a
              href={`/activities/${activity.id}/invitees`}
              className="text-accent underline"
              data-testid="invitees-link"
            >
              {t("invitees.link")}
            </a>
          ) : null}
        </p>
      ) : null}

      <section aria-labelledby="activity-leaders">
        <h2 id="activity-leaders" className="mb-2 text-lg font-semibold">
          {t("activities.leaders")}
        </h2>
        {activity.leaders.length === 0 ? (
          <p className="text-muted">{t("activities.noLeaders")}</p>
        ) : (
          <ul className="space-y-1" data-testid="activity-leaders">
            {activity.leaders.map((person) => (
              <li key={person.id}>
                <PersonName
                  person={person}
                  href={`/people/${person.id}?clubId=${activity.clubId}`}
                  protectedLabel={protectedLabel}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {activity.canManage ? (
        <section aria-labelledby="activity-manage" className="space-y-4">
          <h2 id="activity-manage" className="text-lg font-semibold">
            {t("activities.manage")}
          </h2>
          {activity.seriesId ? (
            <p className="text-sm">
              {activity.detached ? t("activities.detachedHint") : t("activities.seriesHint")}{" "}
              <a
                href={`/activity-series/${activity.seriesId}?split=${activity.id}`}
                className="text-accent underline"
                data-testid="activity-series-link"
              >
                {t("activities.changeFollowing")}
              </a>
            </p>
          ) : null}
          <details className="rounded-lg border border-border p-3">
            <summary className="cursor-pointer font-medium" data-testid="activity-edit">
              {t("activities.edit")}
            </summary>
            <ActionForm
              action="update-activity"
              className="mt-3 space-y-3"
              testId="activity-edit-form"
            >
              <input type="hidden" name="activityId" value={activity.id} />
              <ActivityFields
                timeZone={zone}
                locations={locations}
                values={{
                  kind: activity.kind,
                  title: activity.title,
                  date: localDate(start, zone),
                  startTime: localTime(start, zone),
                  endTime: localTime(new Date(activity.endsAt), zone),
                  meetTime: activity.meetAt ? localTime(new Date(activity.meetAt), zone) : "",
                  meetPlace: activity.meetPlace,
                  locationId: activity.location?.id ?? null,
                  locationText: activity.locationText,
                  opponent: activity.opponent,
                  homeAway: activity.homeAway,
                  competition: activity.competition,
                  notes: activity.notes,
                  leaderNotes: activity.leaderNotes ?? null,
                  responseMode: activity.responseMode ?? null,
                  respondByHours: activity.respondBy
                    ? Math.round((start.getTime() - Date.parse(activity.respondBy)) / 3_600_000)
                    : null,
                }}
              />
              <button type="submit" className={buttonClass} data-testid="activity-save">
                {t("activities.save")}
              </button>
            </ActionForm>
          </details>
          {cancelled ? (
            <ActionForm action="restore-activity" testId="activity-restore-form">
              <input type="hidden" name="activityId" value={activity.id} />
              <button type="submit" className={secondaryButtonClass} data-testid="activity-restore">
                {t("activities.restore")}
              </button>
            </ActionForm>
          ) : (
            <ActionForm
              action="cancel-activity"
              className="flex flex-wrap items-end gap-2"
              testId="activity-cancel-form"
            >
              <input type="hidden" name="activityId" value={activity.id} />
              <label className="block min-w-64 flex-1 space-y-1">
                <span className="text-sm">{t("activities.cancelReason")}</span>
                <input
                  name="reason"
                  maxLength={300}
                  className={inputClass}
                  data-testid="activity-cancel-reason"
                />
              </label>
              <button type="submit" className={secondaryButtonClass} data-testid="activity-cancel">
                {t("activities.cancel")}
              </button>
            </ActionForm>
          )}
          <ActionForm
            action="delete-activity"
            className="flex flex-wrap items-center gap-2"
            testId="activity-delete-form"
          >
            <input type="hidden" name="activityId" value={activity.id} />
            <input type="hidden" name="groupId" value={activity.groups[0]?.id ?? ""} />
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="confirm"
                required
                data-testid="activity-delete-confirm"
              />
              {activity.seriesId
                ? t("activities.deleteSessionConfirm")
                : t("activities.deleteConfirm")}
            </label>
            <button type="submit" className={secondaryButtonClass} data-testid="activity-delete">
              {t("activities.delete")}
            </button>
          </ActionForm>
        </section>
      ) : null}
    </div>
  );
}
