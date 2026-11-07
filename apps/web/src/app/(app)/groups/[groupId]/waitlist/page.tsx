// SPDX-License-Identifier: AGPL-3.0-only
// A group's waiting list for its owners and the club managers (P1.10b, ADR
// 0043): the places, the queue in fair order (priority, then time) with
// filters, and per entry offer, admit, remove, priority and the owners' note.
// Skipping anyone ahead needs a reason (club managers see it). Closed entries
// of the last 12 months on their own tab. Every change is a server action,
// so the page works without JavaScript; times are in the club's time zone.
import { enumKey } from "@clubadmin/i18n";
import {
  type GroupWaitlist,
  WAITLIST_PRIORITY_REASONS,
  WAITLIST_REMOVAL_REASONS,
} from "@clubadmin/shared";
import { formatDateTime, personLabel, PersonName } from "@clubadmin/ui";
import { forbidden } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import {
  ActionForm,
  inputClass,
  secondaryButtonClass,
} from "../../../../../components/action-form.tsx";
import { FormError, Notice } from "../../../../../components/form-error.tsx";
import {
  getClub,
  getGroup,
  getGroupWaitlist,
  getWaitlistSummary,
} from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ groupId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const one = (value: string | string[] | undefined) =>
  typeof value === "string" ? value.trim().slice(0, 40) : "";

const NOTICES = ["offered", "admitted", "removed", "offerWithdrawn", "updated"] as const;

export async function generateMetadata() {
  return { title: (await getTranslations())("waitlist.tab") };
}

export default async function GroupWaitlistPage({ params, searchParams }: Props) {
  const [{ groupId }, query] = await Promise.all([params, searchParams]);
  const [t, locale, group] = await Promise.all([getTranslations(), getLocale(), getGroup(groupId)]);
  if (!group.canManageWaitlist) forbidden();
  const closed = one(query.status) === "closed";
  const birthYear = /^\d{4}$/.test(one(query.birthYear)) ? one(query.birthYear) : "";
  const fitsGender = one(query.fitsGender) === "true";
  const cursor = /^[0-9a-f-]{36}$/.test(one(query.cursor)) ? one(query.cursor) : "";
  const listQuery = new URLSearchParams({ status: closed ? "closed" : "open" });
  if (birthYear) listQuery.set("birthYear", birthYear);
  if (fitsGender) listQuery.set("fitsGender", "true");
  if (cursor) listQuery.set("cursor", cursor);
  const [club, summary, page] = await Promise.all([
    getClub(group.clubId),
    getWaitlistSummary(group.id),
    getGroupWaitlist(group.id, listQuery.toString()),
  ]);
  const when = (value: string) =>
    formatDateTime(value, { locale, timeZone: club.timeZone, dateStyle: "medium" });
  const deadline = (value: string) =>
    formatDateTime(value, {
      locale,
      timeZone: club.timeZone,
      dateStyle: "full",
      timeStyle: "short",
    });
  const full = summary.capacity !== null && summary.occupied >= summary.capacity;
  const protectedLabel = t("protected.tooltip");
  const tab = (status: "open" | "closed", label: string) => (
    <a
      href={`/groups/${group.id}/waitlist${status === "closed" ? "?status=closed" : ""}`}
      aria-current={closed === (status === "closed") ? "page" : undefined}
      className="underline aria-[current=page]:font-semibold aria-[current=page]:no-underline"
    >
      {label}
    </a>
  );
  const nextQuery = new URLSearchParams(listQuery);
  nextQuery.delete("status");
  if (closed) nextQuery.set("status", "closed");
  if (page.nextCursor) nextQuery.set("cursor", page.nextCursor);

  return (
    <div className="space-y-6" data-testid="group-waitlist">
      <div className="space-y-2">
        <p className="text-sm text-muted">
          <a href={`/groups/${group.id}`} className="underline">
            {group.name}
          </a>
        </p>
        <h1 className="text-2xl font-semibold">{t("waitlist.title", { group: group.name })}</h1>
        <FormError code={query.error} />
        {NOTICES.map((n) =>
          query.updated === n ? <Notice key={n}>{t(`waitlist.notices.${n}`)}</Notice> : null,
        )}
        <p data-testid="waitlist-summary">
          {summary.capacity === null
            ? t("waitlist.summaryUnlimited", {
                occupied: summary.occupied,
                offers: summary.offers,
                waiting: summary.waiting,
              })
            : t("waitlist.summary", {
                occupied: summary.occupied,
                capacity: summary.capacity,
                offers: summary.offers,
                waiting: summary.waiting,
              })}
        </p>
        {summary.accepted > 0 ? (
          <p className="text-sm text-muted">
            {t("waitlist.awaitingClubCount", { count: summary.accepted })}
          </p>
        ) : null}
        {summary.autoOffer ? (
          <p className="text-sm text-muted">{t("waitlist.autoOfferOn")}</p>
        ) : null}
      </div>

      <nav className="flex gap-4 text-sm">
        {tab("open", t("waitlist.open"))}
        {tab("closed", t("waitlist.closed"))}
      </nav>

      <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
        {closed ? <input type="hidden" name="status" value="closed" /> : null}
        <label className="space-y-1">
          <span className="block">{t("waitlist.filterBirthYear")}</span>
          <input
            name="birthYear"
            type="number"
            min={1900}
            max={2200}
            defaultValue={birthYear}
            className={`${inputClass} w-28`}
          />
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="fitsGender" value="true" defaultChecked={fitsGender} />
          {t("waitlist.filterFitsGender")}
        </label>
        <button type="submit" className={secondaryButtonClass}>
          {t("waitlist.filter")}
        </button>
      </form>

      {page.items.length === 0 ? (
        <p className="text-muted" data-testid="waitlist-empty">
          {closed ? t("waitlist.emptyClosed") : t("waitlist.empty")}
        </p>
      ) : (
        <ol className="space-y-3">
          {page.items.map((e) => (
            <Entry
              key={e.id}
              entry={e}
              groupId={group.id}
              full={full}
              waiting={summary.waiting}
              replyDays={summary.offerReplyDays}
              protectedLabel={protectedLabel}
              when={when}
              deadline={deadline}
            />
          ))}
        </ol>
      )}
      {page.nextCursor ? (
        <a href={`/groups/${group.id}/waitlist?${nextQuery}`} className="underline">
          {t("waitlist.more")}
        </a>
      ) : null}
    </div>
  );
}

async function Entry({
  entry: e,
  groupId,
  full,
  waiting,
  replyDays,
  protectedLabel,
  when,
  deadline,
}: {
  entry: GroupWaitlist["items"][number];
  groupId: string;
  full: boolean;
  waiting: number;
  replyDays: number;
  protectedLabel: string;
  when: (value: string) => string;
  deadline: (value: string) => string;
}) {
  const t = await getTranslations();
  const open = e.status === "waiting" || e.status === "offered" || e.status === "accepted";
  const ahead = e.position !== null && e.position > 1;
  const hidden = (
    <>
      <input type="hidden" name="groupId" value={groupId} />
      <input type="hidden" name="entryId" value={e.id} />
    </>
  );
  const turn = (
    <>
      {ahead ? (
        <label className="block space-y-1 text-sm">
          <span>{t("waitlist.skipReason")}</span>
          <input
            name="outOfOrderReason"
            required
            maxLength={500}
            className={inputClass}
            data-testid="skip-reason"
          />
        </label>
      ) : null}
      {full ? (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="overCapacity" />
          {t("waitlist.overCapacity")}
        </label>
      ) : null}
    </>
  );
  const facts = [
    e.birthYear !== null ? t("waitlist.born", { year: String(e.birthYear) }) : null,
    e.fitsBirthYears === false ? t("waitlist.outsideBirthYears") : null,
    e.fitsGenderCategory === false ? t("waitlist.outsideCategory") : null,
    t("waitlist.waitingSince", { date: when(e.queuedAt) }),
    e.requestedBy ? t("waitlist.requestedBy", { name: personLabel(e.requestedBy) }) : null,
  ].filter(Boolean);
  return (
    <li className="space-y-2 rounded-lg border border-border p-3" data-testid="waitlist-row">
      <div className="flex flex-wrap items-center gap-3">
        {e.position !== null ? (
          <span className="font-semibold" data-testid="waitlist-position">
            {t("waitlist.position", { position: e.position, count: waiting })}
          </span>
        ) : (
          <span className="font-semibold">{t(enumKey("waitlist.statuses", e.status))}</span>
        )}
        <PersonName person={e.person} protectedLabel={protectedLabel} />
      </div>
      <p className="text-sm text-muted">{facts.join(" · ")}</p>
      {e.priority > 0 && e.priorityReason ? (
        <p className="text-sm">
          {t("waitlist.priorityValue", {
            priority: e.priority,
            reason: t(enumKey("history.priorityReasons", e.priorityReason)),
          })}
        </p>
      ) : null}
      {e.applicantNote ? (
        <p className="text-sm">
          <span className="text-muted">{t("waitlist.applicantNote")}: </span>
          {e.applicantNote}
        </p>
      ) : null}
      {e.status === "offered" && e.offerExpiresAt ? (
        <p className="text-sm" data-testid="waitlist-offer">
          {t("waitlist.offeredUntil", { date: deadline(e.offerExpiresAt) })}
          {e.autoOffer ? ` (${t("waitlist.autoOffer")})` : ""}
        </p>
      ) : null}
      {e.awaitingClub ? <p className="text-sm">{t("waitlist.awaitingClub")}</p> : null}
      {e.outOfOrderReason ? (
        <p className="text-sm">{t("waitlist.outOfOrder", { reason: e.outOfOrderReason })}</p>
      ) : null}
      {!open ? (
        <p className="text-sm text-muted">
          {t("waitlist.closedBecause", {
            status: t(enumKey("waitlist.statuses", e.status)),
            reason: e.closedReason ? t(enumKey("history.closedReasons", e.closedReason)) : "",
          })}
          {e.decidedAt ? ` · ${when(e.decidedAt)}` : ""}
        </p>
      ) : null}

      {open ? (
        <div className="flex flex-wrap gap-3">
          {e.status === "waiting" ? (
            <ActionForm action="offer-place" className="space-y-2" testId="offer-form">
              {hidden}
              <label className="block space-y-1 text-sm">
                <span>{t("waitlist.replyDays")}</span>
                <input
                  name="replyDays"
                  type="number"
                  min={1}
                  max={60}
                  defaultValue={replyDays}
                  className={`${inputClass} w-24`}
                />
              </label>
              {turn}
              <button type="submit" className={secondaryButtonClass} data-testid="offer-place">
                {t("waitlist.offer")}
              </button>
            </ActionForm>
          ) : null}
          {e.status === "offered" ? (
            <ActionForm action="withdraw-offer">
              {hidden}
              <button type="submit" className={secondaryButtonClass} data-testid="withdraw-offer">
                {t("waitlist.withdrawOffer")}
              </button>
            </ActionForm>
          ) : null}
          <ActionForm action="admit-entry" className="space-y-2">
            {hidden}
            {e.status === "waiting" ? turn : null}
            <button type="submit" className={secondaryButtonClass} data-testid="admit-entry">
              {t("waitlist.admit")}
            </button>
          </ActionForm>
          <ActionForm action="remove-entry" className="space-y-2">
            {hidden}
            <label className="block space-y-1 text-sm">
              <span>{t("waitlist.removeReason")}</span>
              <select name="reason" className={inputClass} required>
                {WAITLIST_REMOVAL_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {t(enumKey("waitlist.removalReasons", r))}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className={secondaryButtonClass} data-testid="remove-entry">
              {t("waitlist.remove")}
            </button>
          </ActionForm>
          <ActionForm action="update-waitlist-entry" className="space-y-2">
            {hidden}
            <label className="block space-y-1 text-sm">
              <span>{t("waitlist.priority")}</span>
              <input
                name="priority"
                type="number"
                min={0}
                max={100}
                defaultValue={e.priority}
                className={`${inputClass} w-24`}
              />
            </label>
            <label className="block space-y-1 text-sm">
              <span>{t("waitlist.priorityReason")}</span>
              <select
                name="priorityReason"
                defaultValue={e.priorityReason ?? ""}
                className={inputClass}
              >
                <option value="">–</option>
                {WAITLIST_PRIORITY_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {t(enumKey("history.priorityReasons", r))}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1 text-sm">
              <span>{t("waitlist.ownerNote")}</span>
              <textarea
                name="ownerNote"
                maxLength={500}
                defaultValue={e.ownerNote ?? ""}
                className={inputClass}
              />
            </label>
            <button type="submit" className={secondaryButtonClass}>
              {t("waitlist.save")}
            </button>
          </ActionForm>
        </div>
      ) : null}
    </li>
  );
}
