// SPDX-License-Identifier: AGPL-3.0-only
import type { PersonSummary } from "@clubadmin/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DataList } from "./data-list.tsx";
import { DateTime, formatDateTime, sameOffset } from "./date-time.tsx";
import { personLabel, PersonName } from "./person-name.tsx";

const person = (overrides: Partial<PersonSummary> = {}): PersonSummary => ({
  id: "0199a000-0000-7000-8000-000000000024",
  displayName: "Nadia K",
  givenName: "Nadia",
  familyName: "K",
  protected: false,
  ...overrides,
});

describe("PersonName", () => {
  it("shows the protected-identity icon only for protected people", () => {
    const label = "Protected identity — do not photograph, film or share";
    const shown = renderToStaticMarkup(
      <PersonName person={person({ protected: true })} protectedLabel={label} />,
    );
    expect(shown).toContain("Nadia K");
    expect(shown).toContain(`aria-label="${label}"`);
    expect(
      renderToStaticMarkup(<PersonName person={person()} protectedLabel={label} />),
    ).not.toContain("aria-label");
  });

  it("accepts only a PersonSummary (no extra fields such as a whole person row)", () => {
    const row = { ...person(), personalIdentityNumber: "x" };
    // @ts-expect-error -- extra keys are refused
    expect(personLabel(row)).toBe("Nadia K");
  });
});

describe("DateTime", () => {
  const at = "2026-01-15T13:00:00Z";

  it("formats in the given zone and adds the viewer's when it differs", () => {
    expect(formatDateTime(at, { locale: "nb", timeZone: "Europe/Oslo", timeStyle: "short" })).toBe(
      "14:00",
    );
    const html = renderToStaticMarkup(
      <DateTime
        value={at}
        locale="en-GB"
        timeZone="Europe/Oslo"
        timeStyle="short"
        viewerTimeZone="America/New_York"
        renderViewerTime={(time, zone) => `${time} for you (${zone})`}
      />,
    );
    expect(html).toContain('data-time-zone="Europe/Oslo"');
    expect(html).toContain("14:00");
    expect(html).toContain("08:00 for you");
  });

  it("leaves the viewer's time out when the wall clock is the same", () => {
    expect(sameOffset(at, "Europe/Oslo", "Europe/Stockholm")).toBe(true);
    const html = renderToStaticMarkup(
      <DateTime
        value={at}
        locale="sv"
        timeZone="Europe/Oslo"
        viewerTimeZone="Europe/Stockholm"
        renderViewerTime={() => "viewer"}
      />,
    );
    expect(html).not.toContain("viewer");
  });
});

describe("DataList", () => {
  const page = { items: [{ id: "a" }, { id: "b" }], nextCursor: "b" };
  const render = (nextCursor: string | null) =>
    renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <DataList
          queryKey={["test", nextCursor]}
          initialPage={{ ...page, nextCursor }}
          fetchPage={() => Promise.resolve({ items: [], nextCursor: null })}
          getKey={(item) => item.id}
          renderItem={(item) => <span>{item.id}</span>}
          labels={{ loadMore: "More", loading: "Loading", failed: "Failed" }}
        />
      </QueryClientProvider>,
    );

  it("renders the server's first page and offers the next one only if there is one", () => {
    expect(render("b")).toContain("<span>a</span>");
    expect(render("b")).toContain("More");
    expect(render(null)).not.toContain("More");
  });
});
