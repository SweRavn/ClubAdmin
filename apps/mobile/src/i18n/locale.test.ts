// SPDX-License-Identifier: AGPL-3.0-only
import { acceptLanguage, resolveLocale, resolveTimeZone } from "./locale.ts";

describe("locale chain", () => {
  it("uses the user's preference, then the club, then the device, then English", () => {
    // Lars: Norwegian preference in a Swedish club.
    expect(resolveLocale({ preference: "nb", clubLocale: "sv", deviceLocales: ["en-GB"] })).toBe(
      "nb",
    );
    expect(resolveLocale({ preference: null, clubLocale: "sv-SE", deviceLocales: ["en-GB"] })).toBe(
      "sv",
    );
    expect(resolveLocale({ deviceLocales: ["de-DE", "nn-NO"] })).toBe("nb");
    expect(resolveLocale({ deviceLocales: ["de-DE"] })).toBe("en");
  });

  it("uses the user's time zone, then the club's, then the device's", () => {
    expect(resolveTimeZone({ preference: "Europe/Oslo", clubTimeZone: "Europe/Stockholm" })).toBe(
      "Europe/Oslo",
    );
    expect(resolveTimeZone({ clubTimeZone: "Europe/Stockholm", deviceTimeZone: "UTC" })).toBe(
      "Europe/Stockholm",
    );
    expect(resolveTimeZone({ deviceTimeZone: null })).toBe("UTC");
  });

  it("asks the API for the chosen language first", () => {
    expect(acceptLanguage("sv")).toBe("sv, en;q=0.5");
    expect(acceptLanguage("en")).toBe("en");
  });
});
