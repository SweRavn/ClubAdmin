// SPDX-License-Identifier: AGPL-3.0-only
// Message catalogues (ICU message format, nested by namespace) and locale
// negotiation. The web app reads them through next-intl; the API uses the
// problem titles. Swedish and English are complete (CI test); Norwegian
// (bokmål) falls back to English for missing keys.

import en from "../messages/en.json" with { type: "json" };
import nb from "../messages/nb.json" with { type: "json" };
import sv from "../messages/sv.json" with { type: "json" };

export const SUPPORTED_LOCALES = ["sv", "en", "nb"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
/** Catalogues that must have every key (the others fall back to English). */
export const COMPLETE_LOCALES: readonly Locale[] = ["sv", "en"];

export type Messages = typeof en;
/** A nested catalogue; `nb` may lack keys. */
export interface Catalogue {
  [key: string]: string | Catalogue;
}
export const catalogues: Record<Locale, Catalogue> = { en, sv, nb };

type Leaves<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];
/** A message's full key, e.g. "problem.not-found" or "nav.home". */
export type MessageKey = Leaves<Messages>;

/**
 * A supported locale for a language tag ("sv-SE" → "sv"; Norwegian "no",
 * "nn" and "nb-NO" → "nb"), or null.
 */
export function localeOf(tag: string | null | undefined): Locale | null {
  const language = tag?.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  if (language === "no" || language === "nn") return "nb";
  return SUPPORTED_LOCALES.find((locale) => locale === language) ?? null;
}

/** Picks the best supported locale from an Accept-Language header (RFC 9110 q-values). */
export function negotiateLocale(acceptLanguage: string | undefined): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  const ranked = acceptLanguage
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((p) => /^\s*q=([0-9.]+)\s*$/.exec(p)?.[1]).find((v) => v !== undefined);
      return { tag: tag.trim(), q: q === undefined ? 1 : Number(q), index };
    })
    .filter((entry) => entry.tag !== "" && entry.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const { tag } of ranked) {
    const match = localeOf(tag);
    if (match) return match;
  }
  return DEFAULT_LOCALE;
}

/** Every key of a nested catalogue, dotted. */
export function keysOf(catalogue: Catalogue, prefix = ""): string[] {
  return Object.entries(catalogue).flatMap(([key, value]) =>
    typeof value === "string" ? [`${prefix}${key}`] : keysOf(value, `${prefix}${key}.`),
  );
}

function lookup(catalogue: Catalogue, key: string): string | undefined {
  // Namespaces are the dotted prefix; the last segment is the message (it may contain hyphens).
  let node: string | Catalogue | undefined = catalogue;
  for (const part of key.split(".")) {
    if (typeof node !== "object") return undefined;
    node = node[part];
  }
  return typeof node === "string" ? node : undefined;
}

/** The catalogue with English filled in for missing keys (for `nb`). */
export function withFallback(locale: Locale): Catalogue {
  if (COMPLETE_LOCALES.includes(locale)) return catalogues[locale];
  const merge = (base: Catalogue, over: Catalogue): Catalogue =>
    Object.fromEntries(
      Object.entries(base).map(([key, value]): [string, string | Catalogue] => {
        const own = over[key];
        if (typeof value === "string") return [key, typeof own === "string" ? own : value];
        return [key, merge(value, typeof own === "object" ? own : {})];
      }),
    );
  return merge(catalogues[DEFAULT_LOCALE], catalogues[locale]);
}

/** Namespaces whose keys are the values of an API enum (roles, group kinds, ...). */
export type EnumNamespace =
  "roles" | "functions" | "kinds" | "membershipStatus" | "guardianKinds" | "genders" | "locales";

/**
 * The message key for an enum value from the API. A newer server may send a
 * value this client does not know yet (ADR 0029): it is shown as "Other",
 * never as a raw key or an error.
 */
export function enumKey(namespace: EnumNamespace, value: string): MessageKey {
  const key = `${namespace}.${value}`;
  return (
    lookup(catalogues[DEFAULT_LOCALE], key) === undefined ? "common.other" : key
  ) as MessageKey;
}

export function translate(locale: Locale, key: MessageKey): string {
  return lookup(catalogues[locale], key) ?? lookup(catalogues[DEFAULT_LOCALE], key) ?? key;
}

/** A message with `{name}` placeholders filled in (plain values only; the web app uses next-intl for ICU). */
export function format(
  locale: Locale,
  key: MessageKey,
  values: Readonly<Record<string, string | number>> = {},
): string {
  return translate(locale, key).replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole,
  );
}
