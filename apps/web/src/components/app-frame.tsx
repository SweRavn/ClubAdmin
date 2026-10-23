// SPDX-License-Identifier: AGPL-3.0-only
// The frame around every signed-in page: top bar with the club switcher,
// main navigation, "viewing as" switcher and user menu; the development and
// "viewing as" banners. Data comes from /me, /me/clubs and /me/wards, read in
// parallel.

import { ClubSwitcher, Menu, type MenuItem, personLabel } from "@clubadmin/ui";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";

import { getCurrentClub } from "../server/context.ts";
import { currentPath, getMe, getMyClubs, getMyWards, requireSession } from "../server/data.ts";

export const LOGOUT_FORM = "logout-form";
export const VIEWING_AS_FORM = "viewing-as-form";

export async function AppFrame({ children }: { children: ReactNode }) {
  const session = await requireSession();
  const [t, me, clubs, wards, club, path] = await Promise.all([
    getTranslations(),
    getMe(),
    getMyClubs(),
    getMyWards(),
    getCurrentClub(),
    currentPath(),
  ]);
  const csrf = session.record.csrf;
  const pathname = new URL(path, "https://internal.invalid").pathname;
  const actingFor = wards.wards.filter((w) => w.rights.includes("act_on_behalf"));
  const viewingAs = actingFor.find((w) => w.person.id === session.record.viewingAs) ?? null;
  const myName = personLabel(me.person);

  const nav: { key: string; href: string; label: string; current: boolean }[] = [
    { key: "home", href: "/", label: t("nav.home"), current: pathname === "/" },
    {
      key: "schedule",
      href: "/schedule",
      label: t("nav.schedule"),
      current: pathname.startsWith("/schedule") || pathname.startsWith("/activit"),
    },
  ];
  if (club) {
    nav.push({
      key: "groups",
      href: `/clubs/${club.id}/groups`,
      label: t("nav.groups"),
      current: pathname.startsWith(`/clubs/${club.id}/groups`) || pathname.startsWith("/groups/"),
    });
    if (club.mine?.permissions.includes("club.join_requests.manage")) {
      nav.push({
        key: "join-requests",
        href: `/clubs/${club.id}/join-requests`,
        label: t("nav.joinRequests"),
        current: pathname.startsWith(`/clubs/${club.id}/join-requests`),
      });
    }
    if (club.mine?.permissions.includes("club.invitations.manage")) {
      nav.push({
        key: "invitations",
        href: `/clubs/${club.id}/invitations`,
        label: t("nav.invitations"),
        current: pathname.startsWith(`/clubs/${club.id}/invitations`),
      });
    }
    if (club.mine?.permissions.includes("club.activities.read")) {
      nav.push({
        key: "calendar",
        href: `/clubs/${club.id}/calendar`,
        label: t("nav.calendar"),
        current: pathname.startsWith(`/clubs/${club.id}/calendar`),
      });
    }
    if (club.mine?.permissions.includes("club.locations.manage")) {
      nav.push({
        key: "locations",
        href: `/clubs/${club.id}/locations`,
        label: t("nav.locations"),
        current: pathname.startsWith(`/clubs/${club.id}/locations`),
      });
    }
    if (club.mine?.permissions.includes("club.members.read")) {
      nav.push({
        key: "members",
        href: `/clubs/${club.id}/members`,
        label: t("nav.members"),
        current: pathname.startsWith(`/clubs/${club.id}/members`),
      });
    }
  }

  const userMenu: MenuItem[] = [
    { kind: "link", key: "profile", label: t("userMenu.profile"), href: `/people/${me.personId}` },
    { kind: "link", key: "account", label: t("userMenu.account"), href: "/me" },
    { kind: "link", key: "language", label: t("userMenu.language"), href: "/me/preferences" },
    { kind: "link", key: "sessions", label: t("userMenu.sessions"), href: "/me/sessions" },
    { kind: "separator", key: "sep" },
    { kind: "submit", key: "logout", label: t("userMenu.logout"), form: LOGOUT_FORM },
  ];

  return (
    <>
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-2">
          <a href="/" className="font-semibold">
            {t("common.appName")}
          </a>
          {clubs.clubs.length > 0 ? (
            <ClubSwitcher
              clubs={clubs.clubs.map((c) => ({
                id: c.club.id,
                name: c.club.name,
                href: `/clubs/${c.club.id}`,
              }))}
              currentId={club?.mine ? club.id : null}
              label={t("clubSwitcher.label", { club: club?.name ?? t("clubSwitcher.none") })}
              placeholder={t("clubSwitcher.choose")}
            />
          ) : null}
          <nav aria-label={t("nav.label")} className="order-last w-full sm:order-none sm:w-auto">
            <ul className="flex gap-1">
              {nav.map((item) => (
                <li key={item.key}>
                  <a
                    href={item.href}
                    aria-current={item.current ? "page" : undefined}
                    data-testid={`nav-${item.key}`}
                    className="block rounded-md px-3 py-1.5 text-sm hover:bg-accent-soft aria-[current=page]:bg-accent-soft aria-[current=page]:font-semibold"
                  >
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {actingFor.length > 0 ? (
              <Menu
                label={t("viewingAs.label")}
                testId="viewing-as"
                trigger={
                  <span className="truncate">
                    {t("viewingAs.label")}
                    {": "}
                    {viewingAs ? personLabel(viewingAs.person) : t("viewingAs.self")}
                  </span>
                }
                items={[
                  {
                    kind: "submit",
                    key: "self",
                    label: `${t("viewingAs.self")} (${myName})`,
                    form: VIEWING_AS_FORM,
                    name: "personId",
                    value: "",
                  },
                  ...actingFor.map((w): MenuItem => ({
                    kind: "submit",
                    key: w.person.id,
                    label: personLabel(w.person),
                    form: VIEWING_AS_FORM,
                    name: "personId",
                    value: w.person.id,
                  })),
                ]}
              />
            ) : null}
            <Menu
              label={t("userMenu.label")}
              testId="user-menu"
              trigger={<span className="truncate">{myName}</span>}
              items={userMenu}
            />
          </div>
        </div>
      </header>
      {session.record.devAuth ? (
        <p
          role="status"
          data-testid="dev-banner"
          className="bg-notice px-4 py-1 text-center text-sm text-notice-fg"
        >
          {t("devBanner", { name: myName })}
        </p>
      ) : null}
      {viewingAs ? (
        <div
          role="status"
          data-testid="viewing-as-banner"
          className="flex flex-wrap items-center justify-center gap-3 bg-accent px-4 py-2 text-sm text-accent-fg"
        >
          <span>{t("viewingAs.banner", { name: personLabel(viewingAs.person) })}</span>
          <button
            type="submit"
            form={VIEWING_AS_FORM}
            name="personId"
            value=""
            className="rounded-md border border-accent-fg px-2 py-0.5"
          >
            {t("viewingAs.stop")}
          </button>
        </div>
      ) : null}
      <form id={LOGOUT_FORM} method="post" action="/auth/logout" hidden>
        <input type="hidden" name="csrf" value={csrf} />
      </form>
      <form id={VIEWING_AS_FORM} method="post" action="/me/viewing-as" hidden>
        <input type="hidden" name="csrf" value={csrf} />
        <input type="hidden" name="returnTo" value={path} />
      </form>
      <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">
        {children}
      </main>
    </>
  );
}
