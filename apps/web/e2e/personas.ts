// SPDX-License-Identifier: AGPL-3.0-only
// Demo personas and groups (docs/demodata, fixed IDs; ADR 0026) and helpers
// to log in as them.

import { expect, type Page } from "@playwright/test";

const person = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const club = (n: number) => `0199a000-0000-7000-8001-${String(n).padStart(12, "0")}`;
const group = (n: number) => `0199a000-0000-7000-8002-${String(n).padStart(12, "0")}`;

export const PERSONAS = {
  anna: { id: person(1), name: "Anna Lindqvist" },
  elsa: { id: person(3), name: "Elsa Lindqvist" },
  oskar: { id: person(4), name: "Oskar Lindqvist" },
  erik: { id: person(5), name: "Erik Johansson" },
  sara: { id: person(7), name: "Sara Ahmed" },
  alva: { id: person(8), name: "Alva Ahmed" },
  gunilla: { id: person(9), name: "Gunilla Berg" },
  johan: { id: person(10), name: "Johan Nilsson" },
  lars: { id: person(11), name: "Lars Haugen" },
  karin: { id: person(13), name: "Karin Ek" },
  liam: { id: person(15), name: "Liam Yilmaz" },
  peter: { id: person(16), name: "Peter Sund" },
  emma: { id: person(21), name: "Emma Svensson" },
  samira: { id: person(23), name: "Samira Karimi" },
  nadia: { id: person(24), name: "Nadia Karimi" },
  vera: { id: person(28), name: "Vera Ahmed" },
  elsaDuplicate: { id: person(29), name: "Elsa Lindqvist" },
  tilde: { id: person(32), name: "Tilde Yilmaz" },
} as const;

export const CLUBS = { svk: club(1), ikn: club(2), fil: club(3) } as const;
export const GROUPS = {
  svkF2017: group(1),
  svkHerr: group(3),
  iknP2012: group(5),
  iknF2015: group(7),
} as const;

/** Logs in through the DEV_AUTH picker; returns after landing on `returnTo`. */
export async function loginAs(
  page: Page,
  persona: { id: string; name: string },
  options: { returnTo?: string; mfa?: boolean } = {},
): Promise<void> {
  const returnTo = options.returnTo ?? "/";
  await page.goto(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  if (options.mfa) await page.getByRole("checkbox").check();
  await page
    .getByRole("button", {
      name: new RegExp(`^(Logga in som|Log in as|Logg inn som) ${persona.name}$`),
    })
    .first()
    .click();
  await page.waitForURL((url) => url.pathname === returnTo.split("?")[0]);
  await expect(page.getByTestId("user-menu")).toBeVisible();
}
