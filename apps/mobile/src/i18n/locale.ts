// SPDX-License-Identifier: AGPL-3.0-only
// Language and time zone for the app, the same chains as the web app:
// language = user preference → current club's language → device → English;
// time zone = user preference → club → device. Before login only the device
// counts.

import { DEFAULT_LOCALE, type Locale, localeOf } from "@clubadmin/i18n";

export interface LocaleInputs {
  /** The user's preference (GET /me), if logged in and set. */
  preference?: string | null | undefined;
  /** The current club's default language. */
  clubLocale?: string | null | undefined;
  /** Device languages in order of preference (expo-localization). */
  deviceLocales: readonly string[];
}

export function resolveLocale({ preference, clubLocale, deviceLocales }: LocaleInputs): Locale {
  return (
    localeOf(preference) ??
    localeOf(clubLocale) ??
    deviceLocales.map((tag) => localeOf(tag)).find((l): l is Locale => l !== null) ??
    DEFAULT_LOCALE
  );
}

export interface TimeZoneInputs {
  preference?: string | null | undefined;
  clubTimeZone?: string | null | undefined;
  deviceTimeZone?: string | null | undefined;
}

export function resolveTimeZone({
  preference,
  clubTimeZone,
  deviceTimeZone,
}: TimeZoneInputs): string {
  return preference ?? clubTimeZone ?? deviceTimeZone ?? "UTC";
}

/** Accept-Language for API calls: the chosen language first, then English. */
export const acceptLanguage = (locale: Locale) => (locale === "en" ? "en" : `${locale}, en;q=0.5`);
