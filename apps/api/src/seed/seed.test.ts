// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { loadDemoData } from "./demodata.ts";
import { Generator } from "./generator.ts";
import { resetRefusal, seedRefusal } from "./guard.ts";
import { SeedClock } from "./time.ts";

describe("guard", () => {
  it("refuses production and the hosted service", () => {
    expect(seedRefusal({ NODE_ENV: "production" })).toMatch(/production/);
    expect(seedRefusal({ NODE_ENV: "development", DEPLOYMENT_MODE: "hosted" })).toMatch(/hosted/);
    expect(seedRefusal({ NODE_ENV: "development", DEPLOYMENT_MODE: "self_hosted" })).toBeNull();
  });

  it("resets only in development against a local or explicitly allowed host", () => {
    const dev = { NODE_ENV: "development" };
    expect(resetRefusal(dev, "postgresql://u:p@127.0.0.1:5432/clubadmin")).toBeNull();
    expect(resetRefusal(dev, "postgresql://u:p@localhost/clubadmin")).toBeNull();
    expect(resetRefusal({ NODE_ENV: "test" }, "postgresql://u:p@127.0.0.1/x")).toMatch(
      /development/,
    );
    expect(resetRefusal(dev, "postgresql://u:p@db.example.com/x")).toMatch(/SEED_ALLOW_HOST/);
    expect(
      resetRefusal(
        { ...dev, SEED_ALLOW_HOST: "db.example.com" },
        "postgresql://u:p@db.example.com/x",
      ),
    ).toBeNull();
    expect(resetRefusal({ NODE_ENV: "production" }, "postgresql://u:p@127.0.0.1/x")).toMatch(
      /production/,
    );
  });
});

describe("docs/demodata", () => {
  const data = loadDemoData();

  it("is valid and consistent", () => {
    expect(data.personas.length).toBeGreaterThanOrEqual(25);
    expect(data.clubs.map((c) => c.key)).toEqual(["svk", "ikn", "fil"]);
  });

  it("uses only .test email addresses", () => {
    const emails = [
      ...data.personas.flatMap((p) => (p.email ? [p.email] : [])),
      ...data.relationships.invitations.flatMap((i) => (i.kind === "email" ? [i.email] : [])),
    ];
    expect(emails.length).toBeGreaterThan(20);
    for (const email of emails) expect(email).toMatch(/@[a-z0-9.-]+\.test$/);
  });

  it("gives people without a login no email", () => {
    for (const p of data.personas.filter((x) => x.login === "none")) expect(p.email).toBeNull();
  });
});

describe("SeedClock", () => {
  const clock = new SeedClock(new Date("2026-10-21T12:00:00Z"));

  it("resolves relative times", () => {
    expect(clock.day("-6y")).toBe("2020-10-21");
    expect(clock.day("-14mo")).toBe("2025-08-21");
    expect(clock.day("+3d")).toBe("2026-10-24");
    expect(clock.past("now")).toBeUndefined();
  });

  it("computes birth dates that keep the age", () => {
    expect(clock.birthDate(9, "05-20")).toBe("2017-05-20");
    expect(clock.birthDate(9, "12-01")).toBe("2016-12-01");
    expect(clock.birthDate(10, "02-29")).toBe("2016-02-29");
    expect(clock.birthDate(9, "02-29")).toBe("2017-02-28");
  });
});

describe("Generator", () => {
  it("is deterministic", () => {
    const a = new Generator(1);
    const b = new Generator(1);
    expect([a.person("SE"), a.person("NO", "female")]).toEqual([
      b.person("SE"),
      b.person("NO", "female"),
    ]);
    expect(a.nextId()).toMatch(/^0199a000-0000-7000-8100-[0-9a-f]{12}$/);
  });
});
