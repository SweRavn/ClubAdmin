// SPDX-License-Identifier: AGPL-3.0-only
// Announcements on the web (P2.3, ADR 0053): a row of a board or archive,
// the board (pinned on top, then the newest), and the composer (title,
// Markdown body, audience, channels, important, pin, expiry and sending
// time). The sender's name comes from the PersonPresenter (ADR 0022).
import { enumKey } from "@clubadmin/i18n";
import {
  type Announcement,
  type AnnouncementBoard,
  type AudienceEntry,
  markdownToPlain,
  type Role,
} from "@clubadmin/shared";
import { formatDateTime, personLabel } from "@clubadmin/ui";
import { getLocale, getTimeZone, getTranslations } from "next-intl/server";

import { ActionForm, buttonClass, inputClass, secondaryButtonClass } from "./action-form.tsx";
import { AudienceFields } from "./documents.tsx";

export const announcementHref = (a: { clubId: string; id: string }) =>
  `/clubs/${a.clubId}/announcements/${a.id}`;

const preview = (body: string) => {
  const plain = markdownToPlain(body);
  return plain.length > 160 ? `${plain.slice(0, 157)}…` : plain;
};

/** One announcement in a list: title, badges, from whom and when, a preview. */
export async function AnnouncementRow({
  announcement: a,
  showStatus = false,
}: {
  announcement: Announcement;
  showStatus?: boolean;
}) {
  const [t, locale, timeZone] = await Promise.all([getTranslations(), getLocale(), getTimeZone()]);
  const when = a.sentAt ?? a.scheduledAt;
  return (
    <li
      className="space-y-1 py-3"
      data-testid="announcement"
      data-unread={a.status === "sent" && !a.read ? "true" : "false"}
    >
      <div className="flex flex-wrap items-center gap-2">
        {a.status === "sent" && !a.read ? (
          <span
            className="inline-block size-2 rounded-full bg-accent"
            aria-label={t("announcements.unread")}
          />
        ) : null}
        <a href={announcementHref(a)} className="font-medium underline">
          {a.title}
        </a>
        {a.pinned ? (
          <span className="rounded bg-accent-soft px-1.5 py-0.5 text-xs">
            {t("announcements.pinned")}
          </span>
        ) : null}
        {a.important ? (
          <span className="rounded bg-warning-soft px-1.5 py-0.5 text-xs">
            {t("announcements.important")}
          </span>
        ) : null}
        {showStatus ? (
          <span className="rounded border border-border px-1.5 py-0.5 text-xs" data-testid="status">
            {t(enumKey("announcements.statuses", a.status))}
          </span>
        ) : null}
      </div>
      <p className="text-sm text-muted">
        {a.groupName ?? a.clubName}
        {a.sender ? ` · ${personLabel(a.sender)}` : ""}
        {when
          ? ` · ${formatDateTime(when, { locale, timeZone, dateStyle: "medium", timeStyle: "short" })}`
          : ""}
        {a.editedAt ? ` · ${t("announcements.edited")}` : ""}
      </p>
      <p className="text-sm">{preview(a.body)}</p>
    </li>
  );
}

/** A board: pinned announcements on top, then the newest, and a link to more. */
export async function AnnouncementBoardView({
  board,
  moreHref,
  emptyText,
}: {
  board: AnnouncementBoard;
  moreHref: string | null;
  emptyText: string;
}) {
  const t = await getTranslations();
  if (board.pinned.length === 0 && board.items.length === 0) {
    return (
      <p className="text-muted" data-testid="announcements-empty">
        {emptyText}
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {board.pinned.length > 0 ? (
        <ul
          className="divide-y divide-border rounded-md border border-border px-3"
          data-testid="pinned"
        >
          {board.pinned.map((a) => (
            <AnnouncementRow key={a.id} announcement={a} />
          ))}
        </ul>
      ) : null}
      {board.items.length > 0 ? (
        <ul className="divide-y divide-border" data-testid="announcements">
          {board.items.map((a) => (
            <AnnouncementRow key={a.id} announcement={a} />
          ))}
        </ul>
      ) : null}
      {moreHref ? (
        <a href={moreHref} className="text-sm underline">
          {t("announcements.more")}
        </a>
      ) : null}
    </div>
  );
}

/** A date input's value (YYYY-MM-DD) for an instant, in the club's time zone. */
function dayValue(iso: string | null, timeZone: string): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("sv-SE", { timeZone }).format(new Date(iso));
}

/** A datetime-local input's value for an instant, in the club's time zone. */
function minuteValue(iso: string | null, timeZone: string): string {
  if (!iso) return "";
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
  return parts.replace(" ", "T");
}

/**
 * The composer: a new announcement (of the club, or of `groupId`) or a
 * draft's or scheduled one's changes. Saving keeps a draft; "send" sends now
 * (or at the time given, with "schedule").
 */
export async function AnnouncementComposer({
  clubId,
  groupId,
  timeZone,
  existing,
  audience,
  groups,
  roles,
}: {
  clubId: string;
  groupId: string | null;
  timeZone: string;
  existing: Announcement | null;
  audience: readonly AudienceEntry[];
  groups: readonly { id: string; name: string }[];
  roles: readonly Role[] | null;
}) {
  const t = await getTranslations();
  const channels = new Set(existing?.channels ?? ["board", "push"]);
  const sent = existing?.status === "sent";
  return (
    <ActionForm
      action={existing ? "announcements-update" : "announcements-create"}
      className="space-y-4"
      testId="announcement-composer"
    >
      <input type="hidden" name="clubId" value={clubId} />
      {groupId ? <input type="hidden" name="groupId" value={groupId} /> : null}
      {existing ? <input type="hidden" name="announcementId" value={existing.id} /> : null}
      <input type="hidden" name="timeZone" value={timeZone} />
      <label className="block text-sm">
        {t("announcements.form.title")}
        <input
          name="title"
          required
          maxLength={150}
          defaultValue={existing?.title ?? ""}
          className={inputClass}
        />
      </label>
      <label className="block text-sm">
        {t("announcements.form.body")}
        <textarea
          name="body"
          required
          rows={8}
          maxLength={10_000}
          defaultValue={existing?.body ?? ""}
          className={inputClass}
        />
        <span className="mt-1 block text-xs text-muted">{t("announcements.form.bodyHelp")}</span>
      </label>
      {sent ? null : (
        <>
          <AudienceFields
            current={audience}
            inherit={false}
            groups={groups}
            roles={roles}
            groupId={groupId}
            allowPublic={false}
            groupOnly={groupId !== null}
          />
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">{t("announcements.form.channels")}</legend>
            <input type="hidden" name="channelsShown" value="1" />
            {(["board", "push", "email"] as const).map((c) => (
              <label key={c} className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="channel" value={c} defaultChecked={channels.has(c)} />
                {t(`announcements.channels.${c}`)}
              </label>
            ))}
            <p className="text-xs text-muted">{t("announcements.form.pushHelp")}</p>
            <label className="mt-2 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="important"
                value="true"
                defaultChecked={existing?.important ?? false}
              />
              {t("announcements.form.important")}
            </label>
            <p className="text-xs text-muted">{t("announcements.form.importantHelp")}</p>
          </fieldset>
        </>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          {t("announcements.form.pinnedUntil")}
          <input
            type="date"
            name="pinnedUntil"
            defaultValue={dayValue(existing?.pinnedUntil ?? null, timeZone)}
            className={inputClass}
          />
        </label>
        <label className="block text-sm">
          {t("announcements.form.expiresAt")}
          <input
            type="date"
            name="expiresAt"
            defaultValue={dayValue(existing?.expiresAt ?? null, timeZone)}
            className={inputClass}
          />
        </label>
      </div>
      {sent ? null : (
        <label className="block text-sm">
          {t("announcements.form.scheduledAt")}
          <input
            type="datetime-local"
            name="scheduledAt"
            defaultValue={minuteValue(existing?.scheduledAt ?? null, timeZone)}
            className={inputClass}
          />
          <span className="mt-1 block text-xs text-muted">
            {t("announcements.form.scheduledHelp", { zone: timeZone })}
          </span>
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        {sent ? (
          <button type="submit" className={buttonClass} data-testid="save-announcement">
            {t("announcements.form.saveSent")}
          </button>
        ) : (
          <>
            <button
              type="submit"
              name="send"
              value="send"
              className={buttonClass}
              data-testid="send-announcement"
            >
              {t("announcements.form.sendNow")}
            </button>
            <button
              type="submit"
              name="send"
              value="schedule"
              className={secondaryButtonClass}
              data-testid="schedule-announcement"
            >
              {t("announcements.form.schedule")}
            </button>
            <button
              type="submit"
              name="send"
              value="draft"
              className={secondaryButtonClass}
              data-testid="draft-announcement"
            >
              {t("announcements.form.saveDraft")}
            </button>
          </>
        )}
      </div>
    </ActionForm>
  );
}
