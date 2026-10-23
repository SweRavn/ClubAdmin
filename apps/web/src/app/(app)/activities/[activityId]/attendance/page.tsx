// SPDX-License-Identifier: AGPL-3.0-only
// Taking attendance (P1.5): the roster with present / absent / excused per
// person, prefilled from the answers, the leaders in their own section, a
// guest from the members of the viewer's other groups, and the LOK-stöd
// hints. After the club's lock the list is read-only for leaders; club
// managers and registrars correct it with a reason. Works without client
// JavaScript (one form, radio buttons).
import { enumKey } from "@clubadmin/i18n";
import { ATTENDANCE_STATUSES, type AttendanceMark } from "@clubadmin/shared";
import { personLabel, PersonName } from "@clubadmin/ui";
import { getTranslations } from "next-intl/server";

import { ActionForm, buttonClass, inputClass } from "../../../../../components/action-form.tsx";
import { ClubTime } from "../../../../../components/club-time.tsx";
import { FormError, Notice } from "../../../../../components/form-error.tsx";
import {
  getActivity,
  getAttendance,
  getGroupMembers,
  getMyGroups,
} from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ activityId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("attendance.title") };
}

export default async function AttendancePage({ params, searchParams }: Props) {
  const [{ activityId }, query] = await Promise.all([params, searchParams]);
  const [t, activity, sheet, myGroups] = await Promise.all([
    getTranslations(),
    getActivity(activityId),
    getAttendance(activityId),
    getMyGroups(),
  ]);
  const editable = sheet.canRecord || sheet.canCorrect;
  const protectedLabel = t("protected.tooltip");

  // Guests: members of the viewer's other groups in the club (whose rosters they may read).
  const onSheet = new Set([...sheet.participants, ...sheet.leaders].map((m) => m.person.id));
  // With a call-up (#19) the group's members who were not called up come as guests too.
  const otherGroups = myGroups.groups.filter(
    (g) =>
      g.club.id === activity.clubId &&
      (activity.inviteesOnly || !activity.groups.some((a) => a.id === g.group.id)) &&
      g.functions.some((f) => f !== "member"),
  );
  const rosters = editable
    ? await Promise.all(otherGroups.map((g) => getGroupMembers(g.group.id, 200)))
    : [];
  const guests = new Map(
    rosters
      .flatMap((r) => r?.items ?? [])
      .filter((m) => !onSheet.has(m.person.id))
      .map((m) => [m.person.id, m.person]),
  );

  const row = (mark: AttendanceMark) => (
    <li
      key={mark.person.id}
      className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2"
      data-testid="attendance-row"
    >
      <span className="min-w-48 flex-1">
        <PersonName person={mark.person} protectedLabel={protectedLabel} />
        {mark.guest ? (
          <span className="ml-2 text-xs text-muted">({t("attendance.guests")})</span>
        ) : null}
        {mark.status === null && mark.suggested ? (
          <span className="block text-xs text-muted">
            {t("attendance.suggested", {
              status: t(enumKey("attendanceStatus", mark.suggested)),
            })}
          </span>
        ) : null}
        {mark.correctedReason ? (
          <span className="block text-xs text-muted">
            {t("attendance.corrected", { reason: mark.correctedReason })}
          </span>
        ) : null}
      </span>
      <input type="hidden" name={`role.${mark.person.id}`} value={mark.role} />
      <span className="flex gap-3" role="radiogroup" aria-label={personLabel(mark.person)}>
        {ATTENDANCE_STATUSES.map((status) => (
          <label key={status} className="inline-flex items-center gap-1 text-sm">
            <input
              type="radio"
              name={`mark.${mark.person.id}`}
              value={status}
              defaultChecked={(mark.status ?? mark.suggested) === status}
              disabled={!editable}
              className="h-5 w-5"
              data-testid={`mark-${status}`}
            />
            {t(enumKey("attendanceStatus", status))}
          </label>
        ))}
      </span>
    </li>
  );

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
      <h1 className="text-2xl font-semibold">{t("attendance.title")}</h1>
      {query.saved ? <Notice>{t("attendance.saved")}</Notice> : null}
      {typeof query.stale === "string" ? (
        <p role="status" className="rounded-md bg-protected-soft px-3 py-2">
          {t("attendance.stale", { count: Number(query.stale) })}
        </p>
      ) : null}
      <FormError code={query.error} />
      {sheet.hasProtected ? (
        <p className="rounded-md bg-protected-soft px-3 py-2 text-sm">
          {t("attendance.protectedNotice")}
        </p>
      ) : null}
      {!sheet.open ? <p>{t("attendance.notOpen")}</p> : null}
      {sheet.locked ? <p>{t("attendance.locked")}</p> : null}
      {sheet.hints.length > 0 ? (
        <ul className="space-y-1 text-sm" data-testid="grant-hints">
          {sheet.hints.map((h) => (
            <li key={`${h.scheme}.${h.code}`}>{t(enumKey("grantHints.lok", h.code))}</li>
          ))}
        </ul>
      ) : null}

      <ActionForm action="record-attendance" className="space-y-6" testId="attendance-form">
        <input type="hidden" name="activityId" value={activity.id} />
        <section aria-labelledby="attendance-participants" className="space-y-2">
          <h2 id="attendance-participants" className="text-lg font-semibold">
            {t("attendance.participants")}
          </h2>
          <ul className="divide-y divide-border rounded-lg border border-border bg-raised">
            {sheet.participants.map(row)}
          </ul>
        </section>
        <section aria-labelledby="attendance-leaders" className="space-y-2">
          <h2 id="attendance-leaders" className="text-lg font-semibold">
            {t("attendance.leaders")}
          </h2>
          <ul className="divide-y divide-border rounded-lg border border-border bg-raised">
            {sheet.leaders.map(row)}
          </ul>
        </section>
        {editable && guests.size > 0 ? (
          <label className="block max-w-md space-y-1">
            <span className="text-sm">{t("attendance.addGuest")}</span>
            <select name="guestId" className={inputClass} defaultValue="" data-testid="guest">
              <option value="">{t("attendance.guestPlaceholder")}</option>
              {[...guests.values()].map((p) => (
                <option key={p.id} value={p.id}>
                  {personLabel(p)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {sheet.canCorrect ? (
          <label className="block max-w-md space-y-1">
            <span className="text-sm">{t("attendance.correctionReason")}</span>
            <input
              name="correctedReason"
              required
              maxLength={300}
              className={inputClass}
              data-testid="correction-reason"
            />
          </label>
        ) : null}
        {editable ? (
          <button type="submit" className={buttonClass} data-testid="attendance-save">
            {sheet.canCorrect ? t("attendance.correct") : t("attendance.save")}
          </button>
        ) : null}
      </ActionForm>
    </div>
  );
}
