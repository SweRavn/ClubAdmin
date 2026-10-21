// SPDX-License-Identifier: AGPL-3.0-only
// The catalogue check run in CI: every key exists in Swedish and English,
// Norwegian may fall back to English (reported as a warning), and every
// message is valid ICU with the same placeholders in every language.

import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";

import {
  type Catalogue,
  catalogues,
  COMPLETE_LOCALES,
  format,
  keysOf,
  localeOf,
  negotiateLocale,
  SUPPORTED_LOCALES,
  translate,
  withFallback,
} from "./index.ts";

const flat = (catalogue: Catalogue): Map<string, string> => {
  const out = new Map<string, string>();
  const walk = (node: Catalogue, prefix: string) => {
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === "string") out.set(`${prefix}${key}`, value);
      else walk(value, `${prefix}${key}.`);
    }
  };
  walk(catalogue, "");
  return out;
};

/** Argument names used by an ICU message (placeholders, plural and select arguments). */
function argumentsOf(message: string): string[] {
  const names = new Set<string>();
  const walk = (elements: unknown[]) => {
    for (const element of elements as {
      type: number;
      value?: unknown;
      options?: Record<string, { value: unknown[] }>;
    }[]) {
      if (typeof element.value === "string" && element.type !== 0 && element.type !== 7)
        names.add(element.value);
      for (const option of Object.values(element.options ?? {})) walk(option.value);
    }
  };
  walk(new IntlMessageFormat(message, "en").getAst());
  return [...names].sort();
}

describe("catalogues", () => {
  const english = flat(catalogues.en);

  it.each(COMPLETE_LOCALES)("%s has exactly the keys of en", (locale) => {
    expect([...flat(catalogues[locale]).keys()].sort()).toEqual([...english.keys()].sort());
  });

  it("nb has no keys that en lacks; missing ones fall back to en (warning)", () => {
    const norwegian = flat(catalogues.nb);
    expect([...norwegian.keys()].filter((key) => !english.has(key))).toEqual([]);
    const missing = [...english.keys()].filter((key) => !norwegian.has(key));
    if (missing.length > 0) {
      console.warn(`nb: ${missing.length} message(s) fall back to English: ${missing.join(", ")}`);
    }
    expect(keysOf(withFallback("nb")).sort()).toEqual([...english.keys()].sort());
  });

  it.each(SUPPORTED_LOCALES)("%s: valid ICU with the placeholders of en", (locale) => {
    for (const [key, message] of flat(catalogues[locale])) {
      expect(() => new IntlMessageFormat(message, locale), `${locale} ${key}`).not.toThrow();
      expect(argumentsOf(message), `${locale} ${key}`).toEqual(argumentsOf(english.get(key)!));
    }
  });
});

describe("negotiateLocale", () => {
  it.each([
    [undefined, "en"],
    ["", "en"],
    ["sv-SE,sv;q=0.9,en;q=0.8", "sv"],
    ["en-GB,en;q=0.9", "en"],
    ["de-DE,sv;q=0.5", "sv"],
    ["nb-NO,nb;q=0.9", "nb"],
    ["no", "nb"],
    ["en;q=0.4,sv;q=0.6", "sv"],
    ["sv;q=0", "en"],
  ])("%s → %s", (header, expected) => {
    expect(negotiateLocale(header)).toBe(expected);
  });
});

describe("localeOf", () => {
  it.each([
    ["sv-SE", "sv"],
    ["nb-NO", "nb"],
    ["nn", "nb"],
    ["en", "en"],
    ["de-DE", null],
    [null, null],
  ])("%s → %s", (tag, expected) => {
    expect(localeOf(tag)).toBe(expected);
  });
});

describe("translate", () => {
  it("returns the message in the requested language", () => {
    expect(translate("sv", "problem.not-found")).toBe("Hittades inte");
    expect(translate("en", "problem.not-found")).toBe("Not found");
    expect(translate("nb", "problem.not-found")).toBe("Ikke funnet");
  });
});

describe("format", () => {
  it("fills placeholders", () => {
    expect(format("sv", "account.loggedInAs", { name: "Anna" })).toBe("Inloggad som Anna");
    expect(format("en", "account.loggedInAs")).toBe("Logged in as {name}");
  });
});
