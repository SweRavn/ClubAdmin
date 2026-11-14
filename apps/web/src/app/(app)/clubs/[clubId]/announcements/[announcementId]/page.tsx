// SPDX-License-Identifier: AGPL-3.0-only
// An announcement (P2.3, ADR 0053): its text (the shared Markdown), from
// whom and when, to whom (groups and roles, never names). Opening it marks
// it read. Those who manage it see its state, what happened to it (counts
// only) or, before sending, how many it will reach and what push says; they
// edit, send, withdraw and delete it.
import { enumKey } from "@clubadmin/i18n";
import { formatDateTime, personLabel } from "@clubadmin/ui";
import { getLocale, getTimeZone, getTranslations } from "next-intl/server";

import { ActionForm, secondaryButtonClass } from "../../../../../../components/action-form.tsx";
import { AnnouncementComposer } from "../../../../../../components/announcements.tsx";
import { AudienceText } from "../../../../../../components/documents.tsx";
import { FormError, Notice } from "../../../../../../components/form-error.tsx";
import { Markdown } from "../../../../../../components/markdown.tsx";
import {
  getAnnouncement,
  getAnnouncementRecipients,
  getClub,
  getClubGroups,
  getClubRolesIfAllowed,
  markAnnouncementRead,
  previewAnnouncement,
} from "../../../../../../server/data.ts";

type Props = {
  params: Promise<{ clubId: string; announcementId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props) {
  const { clubId, announcementId } = await params;
  return { title: (await getAnnouncement(clubId, announcementId)).announcement.title };
}

export default async function AnnouncementPage({ params, searchParams }: Props) {
  const [{ clubId, announcementId }, query] = await Promise.all([params, searchParams]);
  const [t, locale, timeZone, detail] = await Promise.all([
    getTranslations(),
    getLocale(),
    getTimeZone(),
    getAnnouncement(clubId, announcementId),
  ]);
  const a = detail.announcement;
  if (a.status === "sent" && !a.read) await markAnnouncementRead(clubId, a.id);
  const manage = a.canManage;
  const [roles, club, recipients] = await Promise.all([
    getClubRolesIfAllowed(clubId),
    manage ? getClub(clubId) : Promise.resolve(null),
    manage && a.status !== "draft" && a.status !== "scheduled"
      ? getAnnouncementRecipients(clubId, a.id)
      : Promise.resolve(null),
  ]);
  const unsent = a.status === "draft" || a.status === "scheduled";
  const reach =
    manage && unsent
      ? await previewAnnouncement(
          clubId,
          a.groupId,
          detail.audience.map((e) =>
            e.kind === "group"
              ? { kind: "group", groupId: e.groupId }
              : e.kind === "group_roles"
                ? { kind: "group_roles", groupId: e.groupId, roleIds: e.roleIds }
                : e.kind === "club_role"
                  ? { kind: "club_role", roleId: e.roleIds[0] }
                  : { kind: e.kind },
          ),
        )
      : null;
  const groups =
    manage && unsent
      ? a.groupId
        ? [{ id: a.groupId, name: a.groupName ?? "" }]
        : (await getClubGroups(clubId)).map((g) => ({ id: g.id, name: g.name }))
      : [];
  const time = (iso: string) =>
    formatDateTime(iso, { locale, timeZone, dateStyle: "medium", timeStyle: "short" });
  const back = a.groupId ? `/groups/${a.groupId}/announcements` : "/me/announcements";
  const from = a.groupName ?? a.clubName;
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <p className="text-sm text-muted">
          <a href={back} className="underline">
            {from}
          </a>
        </p>
        <h1 className="text-2xl font-semibold">{a.title}</h1>
        <p className="text-sm text-muted" data-testid="announcement-meta">
          {a.sender ? personLabel(a.sender) : t("announcements.unknownSender")}
          {a.sentAt ? ` · ${time(a.sentAt)}` : ""}
          {a.editedAt ? ` · ${t("announcements.edited")}` : ""}
          {a.important ? ` · ${t("announcements.important")}` : ""}
        </p>
        <AudienceText entries={detail.audience} roles={roles?.items ?? null} />
      </div>
      <FormError code={query.error} />
      {query.saved ? <Notice>{t("announcements.saved")}</Notice> : null}
      <article className="max-w-prose">
        <Markdown source={a.body} testId="announcement-body" />
      </article>
      {manage ? (
        <section
          aria-labelledby="announcement-manage"
          className="space-y-4"
          data-testid="announcement-manage"
        >
          <h2 id="announcement-manage" className="text-lg font-semibold">
            {t("announcements.manage")}
          </h2>
          <p className="text-sm">
            {t(enumKey("announcements.statuses", a.status))}
            {a.status === "scheduled" && a.scheduledAt
              ? ` · ${t("announcements.scheduledFor", { when: time(a.scheduledAt) })}`
              : ""}
            {` · ${a.channels.map((c) => t(`announcements.channels.${c}`)).join(", ")}`}
          </p>
          {reach ? (
            <div
              className="space-y-1 rounded-md border border-border p-3 text-sm"
              data-testid="announcement-reach"
            >
              <p>
                {t("announcements.reach", {
                  recipients: reach.recipients,
                  email: reach.withEmail,
                  app: reach.withApp,
                })}
              </p>
              <p className="text-muted">
                {t("announcements.pushPreview", {
                  text: t(
                    a.important
                      ? "notify.announcement.important.title"
                      : "notify.announcement.sent.title",
                    { from },
                  ),
                })}
              </p>
            </div>
          ) : null}
          {recipients ? (
            <dl
              className="grid max-w-md grid-cols-2 gap-x-4 gap-y-1 text-sm"
              data-testid="announcement-recipients"
            >
              <dt className="text-muted">{t("announcements.stats.recipients")}</dt>
              <dd>{recipients.recipients ?? "–"}</dd>
              <dt className="text-muted">{t("announcements.stats.read")}</dt>
              <dd>{recipients.read}</dd>
              <dt className="text-muted">{t("announcements.stats.push")}</dt>
              <dd>{t("announcements.stats.delivery", recipients.push)}</dd>
              <dt className="text-muted">{t("announcements.stats.email")}</dt>
              <dd>{t("announcements.stats.delivery", recipients.email)}</dd>
            </dl>
          ) : null}
          {a.status !== "withdrawn" ? (
            <details className="rounded-md border border-border p-3">
              <summary className="cursor-pointer text-sm font-medium">
                {t("announcements.edit")}
              </summary>
              <div className="mt-3">
                <AnnouncementComposer
                  clubId={clubId}
                  groupId={a.groupId}
                  timeZone={club?.timeZone ?? timeZone}
                  existing={a}
                  audience={detail.audience}
                  groups={groups}
                  roles={roles?.items ?? null}
                />
              </div>
            </details>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {a.status !== "withdrawn" ? (
              <ActionForm action="announcements-withdraw" testId="withdraw-announcement">
                <input type="hidden" name="clubId" value={clubId} />
                <input type="hidden" name="announcementId" value={a.id} />
                <button type="submit" className={secondaryButtonClass}>
                  {t("announcements.withdraw")}
                </button>
              </ActionForm>
            ) : null}
            <ActionForm action="announcements-delete" testId="delete-announcement">
              <input type="hidden" name="clubId" value={clubId} />
              <input type="hidden" name="announcementId" value={a.id} />
              <input
                type="hidden"
                name="after"
                value={
                  a.groupId
                    ? `/groups/${a.groupId}/announcements`
                    : `/clubs/${clubId}/announcements`
                }
              />
              <button type="submit" className={secondaryButtonClass}>
                {t("announcements.delete")}
              </button>
            </ActionForm>
          </div>
        </section>
      ) : null}
    </div>
  );
}
