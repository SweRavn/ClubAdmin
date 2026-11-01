// SPDX-License-Identifier: AGPL-3.0-only
// Released consent texts are never edited (P1.8a, ADR 0041): a consent
// records the version the person agreed to, so changing a version's words
// would change what they agreed to. A new wording is a new version
// (`consentTexts.<purpose>.v<n+1>`, and DEFAULT_CONSENT_TEXT_VERSIONS in
// packages/shared); add its hash to consent-texts.lock.json.

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import lock from "./consent-texts.lock.json" with { type: "json" };
import { type Catalogue, catalogues, SUPPORTED_LOCALES } from "./index.ts";

const released = lock as Record<string, string>;

describe("consent texts", () => {
  it("every released version keeps its exact words", () => {
    for (const [key, hash] of Object.entries(released)) {
      const [locale, purpose, version] = key.split(".") as [string, string, string];
      const texts = (catalogues[locale as (typeof SUPPORTED_LOCALES)[number]].consentTexts ??
        {}) as Catalogue;
      const text = (texts[purpose] as Catalogue | undefined)?.[version];
      expect(typeof text, `${key} was removed`).toBe("string");
      expect(
        createHash("sha256")
          .update(text as string)
          .digest("hex"),
        `${key} was edited`,
      ).toBe(hash);
    }
  });

  it("every version in the catalogues is in the lock file", () => {
    for (const locale of SUPPORTED_LOCALES) {
      const texts = (catalogues[locale].consentTexts ?? {}) as Catalogue;
      for (const [purpose, versions] of Object.entries(texts)) {
        for (const version of Object.keys(versions as Catalogue)) {
          expect(released, `${locale}.${purpose}.${version}`).toHaveProperty(
            `${locale}.${purpose}.${version}`,
          );
        }
      }
    }
  });
});
