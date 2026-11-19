// SPDX-License-Identifier: AGPL-3.0-only
// The breadcrumb trail of every page under a club or a group (P2.7b):
// Förening › Grupp › Sida, from the route, so a new page gets it by being
// there. Pages not in the map below show the trail without their own crumb.
// On narrow screens only the parent link shows ("‹ F2017").
import { getTranslations } from "next-intl/server";

import { currentPath } from "../server/data.ts";

/** The page's crumb: the message key of the first path segment after the club or group. */
const CLUB_PAGES: Record<string, string> = {
  administration: "administration.title",
  administrators: "administrators.title",
  announcements: "announcements.archive",
  audit: "audit.title",
  billing: "billing.title",
  calendar: "clubCalendar.title",
  chats: "nav.chat",
  documents: "documents.title",
  duplicates: "family.clubDuplicates.title",
  duties: "duties.title",
  events: "events.title",
  expenses: "expenses.queue",
  folders: "documents.title",
  governing: "governing.title",
  grants: "grants.title",
  groups: "nav.groups",
  history: "history.clubTitle",
  invitations: "invitations.title",
  "join-requests": "joinRequests.title",
  locations: "locations.title",
  managers: "managers.title",
  members: "nav.members",
  plugins: "plugins.title",
  privacy: "privacy.clubTitle",
  "profile-views": "protection.profileViews",
  protected: "protection.protectedMembers",
  roles: "rolesAdmin.title",
  safeguarding: "safeguarding.title",
  settings: "clubSettings.title",
  storage: "documents.storage.title",
  waitlists: "waitlist.clubTitle",
};
/** Club pages reached from "Administration" (P2.7c): Förening › Administration › page. */
const ADMINISTRATION_PAGES = new Set([
  "administrators",
  "audit",
  "billing",
  "duplicates",
  "grants",
  "history",
  "invitations",
  "join-requests",
  "locations",
  "plugins",
  "privacy",
  "profile-views",
  "protected",
  "roles",
  "settings",
  "storage",
  "waitlists",
]);
const GROUP_PAGES: Record<string, string> = {
  announcements: "announcements.title",
  archive: "groupForm.archiveTitle",
  attendance: "attendance.summary",
  carpools: "carpool.stats",
  consents: "privacy.groupConsents",
  documents: "documents.title",
  duties: "duties.title",
  edit: "groupForm.editTitle",
  manage: "groupAdmin.title",
  waitlist: "waitlist.tab",
};

export async function Breadcrumbs({
  club,
  group,
}: {
  club: { id: string; name: string };
  group?: { id: string; name: string } | undefined;
}) {
  const [t, path] = await Promise.all([getTranslations(), currentPath()]);
  const pathname = new URL(path, "https://internal.invalid").pathname;
  const base = group ? `/groups/${group.id}` : `/clubs/${club.id}`;
  const segment = pathname.startsWith(`${base}/`)
    ? pathname.slice(base.length + 1).split("/")[0]
    : undefined;
  const pageKey = segment ? (group ? GROUP_PAGES : CLUB_PAGES)[segment] : undefined;
  const crumbs: { href: string; label: string }[] = [
    { href: `/clubs/${club.id}`, label: club.name },
    ...(group ? [{ href: base, label: group.name }] : []),
    ...(!group && segment && ADMINISTRATION_PAGES.has(segment)
      ? [{ href: `${base}/administration`, label: t("administration.title") }]
      : []),
    ...(pageKey && segment ? [{ href: `${base}/${segment}`, label: t(pageKey as never) }] : []),
  ];
  const current = crumbs.findLastIndex((c) => c.href === pathname);
  const last = current === -1 ? crumbs.length : current + 1;
  const shown = crumbs.slice(0, last);
  if (shown.length <= 1 && current === 0) return null;
  const parent = current > 0 ? crumbs[current - 1] : crumbs.at(-1);
  return (
    <nav aria-label={t("nav.breadcrumbs")} className="mb-4 text-sm" data-testid="breadcrumbs">
      {parent ? (
        <a href={parent.href} className="text-accent underline sm:hidden">
          ‹ {parent.label}
        </a>
      ) : null}
      <ol className="hidden flex-wrap items-center gap-1 sm:flex">
        {shown.map((c, i) => (
          <li key={c.href} className="flex items-center gap-1">
            {i > 0 ? <span aria-hidden="true">›</span> : null}
            {i === current ? (
              <span aria-current="page" className="font-medium">
                {c.label}
              </span>
            ) : (
              <a href={c.href} className="text-accent underline">
                {c.label}
              </a>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
