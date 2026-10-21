// SPDX-License-Identifier: AGPL-3.0-only
// The web shell (P0.9) on the demo data: protected identity, locale and time
// zones, cross-club access, "viewing as", navigation, accessibility and the
// security headers of `next dev` (the production build has its own spec).

import AxeBuilder from "@axe-core/playwright";
import { type Browser, type Cookie, expect, type Page, test } from "@playwright/test";

import { CLUBS, GROUPS, loginAs, PERSONAS } from "./personas.ts";

/** Session cookies per persona: logging in once each keeps the suite under the login rate limit. */
const sessions = new Map<string, Cookie[]>();

async function asPersona(
  browser: Browser,
  persona: { id: string; name: string },
  options: { locale?: string; timezoneId?: string } = {},
): Promise<Page> {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    locale: options.locale ?? "sv-SE",
    timezoneId: options.timezoneId ?? "Europe/Stockholm",
  });
  const page = await context.newPage();
  const saved = sessions.get(persona.id);
  if (saved) {
    await context.addCookies(saved);
    await page.goto("/");
    if (await page.getByTestId("user-menu").isVisible()) return page;
  }
  await loginAs(page, persona);
  sessions.set(
    persona.id,
    (await context.cookies()).filter((c) => c.name.startsWith("__Host-")),
  );
  return page;
}

const nadia = (page: Page) => page.locator(`[data-person-id="${PERSONAS.nadia.id}"]`);

test.describe("protected identity on IK Norrbacka F2015", () => {
  const url = `/groups/${GROUPS.iknF2015}`;

  test("Liam (member of the club, not of the group) does not see Nadia", async ({ browser }) => {
    const page = await asPersona(browser, PERSONAS.liam);
    await page.goto(url);
    await expect(page.getByTestId("group-name")).toContainText("F");
    await expect(nadia(page)).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText("Nadia");
    await page.context().close();
  });

  test("Erik (assistant coach) sees Nadia with the crossed-camera icon", async ({ browser }) => {
    const page = await asPersona(browser, PERSONAS.erik);
    await page.goto(url);
    const row = nadia(page).first();
    await expect(row).toContainText(PERSONAS.nadia.name);
    const badge = row.getByTestId("protected-badge");
    const tooltip = "Skyddad identitet — fotografera, filma eller dela inte";
    await expect(badge).toHaveAttribute("aria-label", tooltip);
    await badge.focus();
    await expect(page.getByRole("tooltip")).toHaveText(tooltip);
    // Erik himself is not protected: no icon on his row.
    await expect(
      page.locator(`[data-person-id="${PERSONAS.erik.id}"]`).first().getByTestId("protected-badge"),
    ).toHaveCount(0);
    await page.context().close();
  });

  test("Samira (Nadia's guardian) sees Nadia", async ({ browser }) => {
    const page = await asPersona(browser, PERSONAS.samira);
    await page.goto(url);
    await expect(nadia(page).first()).toContainText(PERSONAS.nadia.name);
    await expect(nadia(page).first().getByTestId("protected-badge")).toBeVisible();
    await page.context().close();
  });

  test("Emma (no club) gets the not-found page", async ({ browser }) => {
    const page = await asPersona(browser, PERSONAS.emma);
    await page.goto(url);
    await expect(page.getByTestId("not-found")).toBeVisible();
    await expect(page.locator("body")).not.toContainText("F2015");
    await page.context().close();
  });
});

test.describe("locale and time zone", () => {
  test("Lars sees Norwegian (his preference), also in a Swedish club", async ({ browser }) => {
    const page = await asPersona(browser, PERSONAS.lars, { locale: "sv-SE" });
    await expect(page.locator("html")).toHaveAttribute("lang", "nb");
    await page.goto(`/clubs/${CLUBS.svk}`);
    await expect(page.locator("html")).toHaveAttribute("lang", "nb");
    await expect(page.getByRole("heading", { name: "Om klubben" })).toBeVisible();
    await page.context().close();
  });

  test("Liam sees English (his preference)", async ({ browser }) => {
    const page = await asPersona(browser, PERSONAS.liam, { locale: "sv-SE" });
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("heading", { name: "My groups" })).toBeVisible();
    await page.context().close();
  });

  test("Anna sees Swedish (her club's language) even with an English browser", async ({
    browser,
  }) => {
    const page = await asPersona(browser, PERSONAS.anna, { locale: "en-US" });
    await expect(page.locator("html")).toHaveAttribute("lang", "sv");
    await expect(page.getByRole("heading", { name: "Mina föreningar" })).toBeVisible();
    await page.context().close();
  });

  test("Fjordvik IL's pages show Europe/Oslo time, and the viewer's own", async ({ browser }) => {
    const page = await asPersona(browser, PERSONAS.lars, { timezoneId: "America/New_York" });
    // The browser's zone reaches the server (a cookie set after hydration) with the next request.
    await expect
      .poll(async () => (await page.context().cookies()).find((c) => c.name === "ca-tz")?.value)
      .toBe(encodeURIComponent("America/New_York"));
    await page.goto(`/clubs/${CLUBS.fil}`);
    const clubTime = page.getByTestId("club-time");
    await expect(clubTime.locator("[data-time-zone]")).toHaveAttribute(
      "data-time-zone",
      "Europe/Oslo",
    );
    await expect(clubTime.locator("[data-viewer-time-zone]")).toHaveAttribute(
      "data-viewer-time-zone",
      "America/New_York",
    );
    const iso = await clubTime.locator("time").getAttribute("datetime");
    const oslo = new Intl.DateTimeFormat("nb", {
      timeZone: "Europe/Oslo",
      timeStyle: "short",
    }).format(new Date(iso!));
    await expect(clubTime.locator("time")).toContainText(oslo);
    await page.context().close();
  });
});

test("another club's pages show the not-found page", async ({ browser }) => {
  // Liam is only in IK Norrbacka.
  const page = await asPersona(browser, PERSONAS.liam);
  for (const url of [
    `/clubs/${CLUBS.svk}`,
    `/clubs/${CLUBS.svk}/groups`,
    `/groups/${GROUPS.svkHerr}`,
  ]) {
    await page.goto(url);
    await expect(page.getByTestId("not-found"), url).toBeVisible();
    await expect(page.locator("body"), url).not.toContainText("Strandvikens");
  }
  await page.context().close();
});

test("Anna views as Elsa and as Oskar, then as herself", async ({ browser }) => {
  const page = await asPersona(browser, PERSONAS.anna);
  const switchTo = async (name: string) => {
    await page.getByTestId("viewing-as").click();
    await Promise.all([
      page.waitForEvent("framenavigated"),
      page.getByRole("menuitem", { name }).click(),
    ]);
  };
  await expect(page.getByTestId("viewing-as-banner")).toHaveCount(0);

  await switchTo(PERSONAS.elsa.name);
  await expect(page.getByTestId("viewing-as-banner")).toContainText(PERSONAS.elsa.name);
  await expect(page.getByTestId("my-groups")).toContainText("Strandvikens Volleybollklubb");
  await expect(page.getByTestId("club-switcher")).toContainText("Strandvikens");

  await switchTo(PERSONAS.oskar.name);
  await expect(page.getByTestId("viewing-as-banner")).toContainText(PERSONAS.oskar.name);
  await expect(page.getByTestId("my-groups")).toContainText("IK Norrbacka");
  await expect(page.getByTestId("my-groups")).not.toContainText("Strandvikens");
  // The API sees Oskar: the roster of his own team is open to him.
  await page.goto(`/groups/${GROUPS.iknP2012}`);
  await expect(page.locator(`[data-person-id="${PERSONAS.oskar.id}"]`).first()).toBeVisible();

  await Promise.all([
    page.waitForEvent("framenavigated"),
    page.getByTestId("viewing-as-banner").getByRole("button").click(),
  ]);
  await expect(page.getByTestId("viewing-as-banner")).toHaveCount(0);
  await page.context().close();
});

test("switch clubs, browse groups and members; the last club is remembered", async ({
  browser,
}) => {
  // Lars: Strandviken (member), IK Norrbacka (supporting member), Fjordvik IL (club manager).
  const page = await asPersona(browser, PERSONAS.lars);
  await page.getByTestId("club-switcher").click();
  await page.getByRole("menuitem", { name: "Fjordvik Idrettslag" }).click();
  await expect(page).toHaveURL(new RegExp(`/clubs/${CLUBS.fil}$`));
  // Members only with the club.members.read permission (club managers).
  await expect(page.getByTestId("nav-members")).toBeVisible();

  await page.getByTestId("nav-groups").click();
  await expect(page).toHaveURL(new RegExp(`/clubs/${CLUBS.fil}/groups$`));
  await page.getByTestId("groups-tree").getByRole("link").first().click();
  await expect(page.getByTestId("group-name")).toBeVisible();

  await page.goto("/");
  await expect(page.getByTestId("club-switcher")).toContainText("Fjordvik");

  await page.goto(`/clubs/${CLUBS.ikn}`);
  await expect(page.getByTestId("nav-members")).toHaveCount(0);
  await page.goto(`/clubs/${CLUBS.ikn}/members`);
  await expect(page.getByTestId("forbidden")).toBeVisible();
  await page.context().close();
});

test("a roster longer than a page loads the next page on request", async ({ browser }) => {
  // Anna manages Strandviken; F2017 has 13 members.
  const page = await asPersona(browser, PERSONAS.anna);
  await page.goto(`/groups/${GROUPS.svkF2017}?limit=10`);
  const roster = page.getByTestId("group-members");
  await expect(roster.locator("li")).toHaveCount(10);
  await roster.getByRole("button", { name: "Visa fler" }).click();
  await expect(roster.locator("li")).toHaveCount(13);
  await expect(roster.getByRole("button", { name: "Visa fler" })).toHaveCount(0);
  await page.context().close();
});

test("Emma, without a club, gets the onboarding placeholder", async ({ browser }) => {
  const page = await asPersona(browser, PERSONAS.emma);
  const onboarding = page.getByTestId("onboarding");
  await expect(onboarding.getByRole("button", { name: "Hitta en förening" })).toBeDisabled();
  await expect(onboarding.getByRole("button", { name: "Skapa en förening" })).toBeDisabled();
  await page.context().close();
});

test("keyboard: skip link and the user menu", async ({ browser }) => {
  const page = await asPersona(browser, PERSONAS.erik);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Hoppa till huvudinnehållet" })).toBeFocused();
  await page.getByTestId("user-menu").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.getByTestId("user-menu")).toBeFocused();
  await page.context().close();
});

test("no serious accessibility violations (axe)", async ({ browser }) => {
  const page = await asPersona(browser, PERSONAS.erik);
  const pages = [
    "/",
    `/clubs/${CLUBS.ikn}`,
    `/clubs/${CLUBS.ikn}/groups`,
    `/groups/${GROUPS.iknF2015}`,
    `/people/${PERSONAS.erik.id}?clubId=${CLUBS.ikn}`,
    "/me",
    "/me/sessions",
    "/me/preferences",
    "/groups/00000000-0000-7000-8000-000000000000",
  ];
  for (const url of pages) {
    await page.goto(url);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    const serious = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(
      serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
      url,
    ).toEqual([]);
  }
  await page.context().close();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const login = await context.newPage();
  await login.goto("/login");
  const results = await new AxeBuilder({ page: login }).analyze();
  expect(
    results.violations.filter((v) => v.impact === "serious" || v.impact === "critical"),
  ).toEqual([]);
  await context.close();
});

test("security headers and a nonce-based CSP (next dev)", async ({ browser }) => {
  const page = await asPersona(browser, PERSONAS.erik);
  const response = await page.goto(`/groups/${GROUPS.iknF2015}`);
  const headers = response!.headers();
  const csp = headers["content-security-policy"]!;
  expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("same-origin");
  // Every script in the page's HTML carries this request's nonce (scripts
  // that load later are allowed by 'strict-dynamic').
  const nonce = /'nonce-([^']+)'/.exec(csp)![1]!;
  const scripts = [...(await response!.text()).matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  expect(scripts.length).toBeGreaterThan(0);
  expect(scripts.filter((tag) => !tag.includes(`nonce="${nonce}"`))).toEqual([]);
  // A second request gets a different nonce.
  const again = await page.request.get(`/groups/${GROUPS.iknF2015}`);
  expect(again.headers()["content-security-policy"]).not.toContain(nonce);
  await page.context().close();
});
