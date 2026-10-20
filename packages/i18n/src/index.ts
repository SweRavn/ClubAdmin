// SPDX-License-Identifier: AGPL-3.0-only
// Message catalogues (ICU message format) and locale negotiation.
// The full i18n setup for the web and mobile apps arrives in P0.9; the API
// uses this for translated problem-details titles.

import en from "../messages/en.json" with { type: "json" };
import sv from "../messages/sv.json" with { type: "json" };

export const SUPPORTED_LOCALES = ["sv", "en"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

export type MessageKey = keyof typeof en;
export const catalogues: Record<Locale, Record<MessageKey, string>> = { en, sv };

/**
 * Picks the best supported locale from an Accept-Language header
 * (RFC 9110 q-values; "sv-SE" matches "sv"). Norwegian falls back to English
 * until a Norwegian catalogue exists.
 */
export function negotiateLocale(acceptLanguage: string | undefined): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  const ranked = acceptLanguage
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((p) => /^\s*q=([0-9.]+)\s*$/.exec(p)?.[1]).find((v) => v !== undefined);
      return {
        language: tag.trim().toLowerCase().split("-")[0] ?? "",
        q: q === undefined ? 1 : Number(q),
        index,
      };
    })
    .filter((entry) => entry.language !== "" && entry.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const { language } of ranked) {
    const match = SUPPORTED_LOCALES.find((locale) => locale === language);
    if (match) return match;
  }
  return DEFAULT_LOCALE;
}

export function translate(locale: Locale, key: MessageKey): string {
  return catalogues[locale][key] ?? catalogues[DEFAULT_LOCALE][key];
}
