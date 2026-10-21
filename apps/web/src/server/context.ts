// SPDX-License-Identifier: AGPL-3.0-only
// The request's context for the app frame and i18n: the current club (from
// the URL, else the person's last club, else their first), and the locale and
// time zone. Locale: user preference → current club's default → the
// browser's Accept-Language → en. Time zone: user preference → club → browser.

import { DEFAULT_LOCALE, type Locale, localeOf, negotiateLocale } from "@clubadmin/i18n";
import { isUuid, type MyClubs } from "@clubadmin/shared";
import { cookies, headers } from "next/headers";
import { after } from "next/server";
import { cache } from "react";

import { currentPath, getClub, getGroup, getMe, getMyClubs, getSession } from "./data.ts";
import { lastClub, rememberClub } from "./last-club.ts";

/** Set by a small script in the browser (BrowserTimeZone) with its IANA time zone. */
export const TIME_ZONE_COOKIE = "ca-tz";

export interface CurrentClub {
  id: string;
  name: string;
  defaultLocale: string;
  timeZone: string;
  /** From GET /me/clubs: the viewer's own club (else reached through a URL, e.g. a ward's club). */
  mine: MyClubs["clubs"][number] | null;
}

/** Runs a loader, turning redirects, 404s and failures into null (for layout and i18n decisions). */
async function quietly<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch {
    return null;
  }
}

const isTimeZone = (value: string | undefined | null): value is string => {
  if (!value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

/** The club the URL points at (club pages, group pages, profiles with ?clubId=). */
async function clubIdFromPath(path: string): Promise<string | null> {
  const url = new URL(path, "https://internal.invalid");
  const club = /^\/clubs\/([^/]+)/.exec(url.pathname)?.[1];
  if (club && isUuid(club)) return club;
  const group = /^\/groups\/([^/]+)/.exec(url.pathname)?.[1];
  if (group && isUuid(group)) return (await quietly(() => getGroup(group)))?.clubId ?? null;
  const fromQuery = url.searchParams.get("clubId");
  return fromQuery && isUuid(fromQuery) ? fromQuery : null;
}

export const getCurrentClub = cache(async (): Promise<CurrentClub | null> => {
  const session = await getSession();
  if (!session) return null;
  const clubs = (await quietly(getMyClubs))?.clubs ?? [];
  const fromUrl = await clubIdFromPath(await currentPath());
  const mine = (id: string | null) => clubs.find((c) => c.club.id === id) ?? null;
  if (fromUrl) {
    const own = mine(fromUrl);
    if (own) {
      if (!session.record.viewingAs) after(() => rememberClub(session.record.personId, fromUrl));
      return { ...own.club, mine: own };
    }
    const other = await quietly(() => getClub(fromUrl));
    if (other) return { ...other, mine: null };
  }
  const remembered = mine(await lastClub(session.record.personId)) ?? clubs[0] ?? null;
  return remembered ? { ...remembered.club, mine: remembered } : null;
});

export const resolveLocale = cache(async (): Promise<Locale> => {
  if (await getSession()) {
    const me = await quietly(getMe);
    if (me?.preferences.locale) return me.preferences.locale;
    const club = await getCurrentClub();
    const fromClub = localeOf(club?.defaultLocale);
    if (fromClub) return fromClub;
  }
  const accepted = (await headers()).get("accept-language");
  return accepted ? negotiateLocale(accepted) : DEFAULT_LOCALE;
});

/** The browser's zone, if it told us (cookie). */
export const browserTimeZone = cache(async (): Promise<string | null> => {
  const value = (await cookies()).get(TIME_ZONE_COOKIE)?.value;
  return isTimeZone(value) ? value : null;
});

/** The viewer's own zone: their preference, else the browser's. */
export const viewerTimeZone = cache(async (): Promise<string | null> => {
  const me = (await getSession()) ? await quietly(getMe) : null;
  return me?.preferences.timeZone ?? (await browserTimeZone());
});

/** The zone for times without a club of their own: user → current club → browser → UTC. */
export const resolveTimeZone = cache(async (): Promise<string> => {
  const me = (await getSession()) ? await quietly(getMe) : null;
  return (
    me?.preferences.timeZone ??
    (await getCurrentClub())?.timeZone ??
    (await browserTimeZone()) ??
    "UTC"
  );
});
