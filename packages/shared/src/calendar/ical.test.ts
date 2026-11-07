// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { escapeText, foldLine, formatDate, formatUtc, writeCalendar } from "./ical.ts";

/** Unfolds and splits as a reader does (RFC 5545 3.1), checking the line rules on the way. */
function parse(text: string): string[] {
  expect(text.endsWith("\r\n")).toBe(true);
  const raw = text.slice(0, -2).split("\r\n");
  for (const line of raw) {
    expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(line).not.toMatch(/[\r\n]/);
  }
  const lines: string[] = [];
  for (const line of raw) {
    if (line.startsWith(" ")) lines[lines.length - 1] += line.slice(1);
    else lines.push(line);
  }
  return lines;
}

const unescape = (v: string) =>
  v.replace(/\\(n|N|;|,|\\)/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));

describe("iCalendar writer", () => {
  it("escapes text values", () => {
    expect(escapeText("a;b,c\\d\ne")).toBe("a\\;b\\,c\\\\d\\ne");
  });

  it("folds at 75 octets without splitting UTF-8 characters", () => {
    const line = `SUMMARY:${"Åsa och Öjvind ".repeat(10)}`;
    const folded = foldLine(line);
    for (const part of folded.split("\r\n")) {
      expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
    }
    expect(
      folded
        .split("\r\n")
        .map((p, i) => (i ? p.slice(1) : p))
        .join(""),
    ).toBe(line);
  });

  it("formats UTC times and dates in a zone", () => {
    expect(formatUtc(new Date("2026-03-14T16:30:00Z"))).toBe("20260314T163000Z");
    // 23:30 UTC is the next day in Stockholm.
    expect(formatDate(new Date("2026-03-14T23:30:00Z"), "Europe/Stockholm")).toBe("20260315");
  });

  it("writes a valid calendar with timed, all-day and cancelled events", () => {
    const text = writeCalendar({
      prodId: "-//ClubAdmin//test//EN",
      name: "Strandvikens VK – F2017",
      timeZone: "Europe/Stockholm",
      events: [
        {
          uid: "a@clubadmin.test",
          stamp: new Date("2026-03-01T00:00:00Z"),
          start: new Date("2026-03-14T16:30:00Z"),
          end: new Date("2026-03-14T18:00:00Z"),
          allDay: false,
          timeZone: "Europe/Stockholm",
          sequence: 2,
          lastModified: new Date("2026-03-02T10:00:00Z"),
          cancelled: true,
          summary: "Inställt: Träning, F2017",
          location: "Strandhallen, Strandvägen 1",
          geo: { latitude: 59.3, longitude: 18.1 },
          description: "Elsa kommer\nSvara: https://x.test/answer/abc;def",
          url: "https://clubadmin.test/activities/a",
          categories: "training",
        },
        {
          uid: "b@clubadmin.test",
          stamp: new Date("2026-03-01T00:00:00Z"),
          start: new Date("2026-03-20T23:00:00Z"),
          end: new Date("2026-03-21T23:00:00Z"),
          allDay: true,
          timeZone: "Europe/Stockholm",
          sequence: 0,
          lastModified: new Date("2026-03-02T10:00:00Z"),
          cancelled: false,
          summary: "Cup",
        },
      ],
    });
    const lines = parse(text);
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines.at(-1)).toBe("END:VCALENDAR");
    expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(2);
    expect(lines.filter((l) => l === "END:VEVENT")).toHaveLength(2);
    expect(lines).toContain("STATUS:CANCELLED");
    expect(lines).toContain("SEQUENCE:2");
    expect(lines).toContain("DTSTART:20260314T163000Z");
    expect(lines).toContain("DTSTART;VALUE=DATE:20260321");
    expect(lines).toContain("DTEND;VALUE=DATE:20260322");
    const description = lines.find((l) => l.startsWith("DESCRIPTION:"))!;
    expect(unescape(description.slice("DESCRIPTION:".length))).toBe(
      "Elsa kommer\nSvara: https://x.test/answer/abc;def",
    );
    expect(lines).toContain("REFRESH-INTERVAL;VALUE=DURATION:PT1H");
  });
});
