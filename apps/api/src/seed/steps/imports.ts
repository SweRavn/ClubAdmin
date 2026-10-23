// SPDX-License-Identifier: AGPL-3.0-only
// Demo member imports (P1.3b, docs/seed-data.md): Lars's finished import in
// FIL (a handful of rows, with its report) and Karin's import of the sample
// file (docs/demodata/imports/medlemmar.csv) in IKN, left in review with a
// possible duplicate (Oskar) and an error row, so the preview can be tried.
// Both go through the import service, as an upload would.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { demoDataDir } from "../demodata.ts";
import type { DemoStep } from "../environment.ts";

/** Fixed IDs of the demo imports. */
export const DEMO_IMPORT_IDS = {
  fil: "0199a000-0000-7000-8010-000000000001",
  ikn: "0199a000-0000-7000-8010-000000000002",
} as const;

export const importsDemoStep: DemoStep = {
  name: "imports",
  async run(env, data, core) {
    const s = env.services;
    const id = (key: string) => {
      const value = core.ids.get(key);
      if (!value) throw new Error(`no id for ${key}`);
      return value;
    };
    const as = (person: string, club: string) => ({
      actorKind: "person" as const,
      personId: id(person),
      clubId: id(club),
      requestId: "seed:demo",
    });

    // FIL: a finished import of four members (two siblings share a parent).
    const lars = as("lars", "fil");
    const team = (await s.groups.getGroup(lars, id("fil-j2014"))).name;
    const filFile = [
      "Fornavn;Etternavn;Fødselsdato;Gruppe;Foresatt 1 fornavn;Foresatt 1 etternavn;Foresatt 1 mobil;Foresatt 1 relasjon",
      `Sindre;Bakke;2014-02-11;${team};Hilde;Bakke;+47 912 34 567;Forelder`,
      `Mia;Bakke;2014-02-11;${team};Hilde;Bakke;+47 912 34 567;Forelder`,
      `Tobias;Strand;2014-09-30;${team};Kari;Strand;+47 913 45 678;Forelder`,
      "Per;Nygård;1968-06-01;Veteran;;;;",
    ].join("\n");
    const fil = await s.imports.importFile(lars, Buffer.from(filFile, "utf8"), {
      id: DEMO_IMPORT_IDS.fil,
    });
    await s.imports.confirm(lars, fil.id);
    // Fixed IDs: the same demo every time (rows 1 to 4, guardian 0 of each).
    await s.imports.runJob(fil.id, id("fil"), (rowNumber, guardian) =>
      guardian === null
        ? `0199a000-0000-7000-8011-${String(rowNumber).padStart(12, "0")}`
        : `0199a000-0000-7000-8012-${String(rowNumber * 100 + guardian).padStart(12, "0")}`,
    );

    // IKN: the sample file, plus Oskar (already a member) and a row without a birth date.
    const karin = as(data.clubs.find((c) => c.key === "ikn")!.actor, "ikn");
    const oskar = data.personas.find((p) => p.key === "oskar")!;
    const oskarBorn = env.clock.birthDate(oskar.age!, oskar.birthday!);
    const sample = new TextDecoder("windows-1252").decode(
      readFileSync(join(demoDataDir(), "imports", "medlemmar.csv")),
    );
    const width = sample.split("\r\n")[0]!.split(";").length;
    const row = (cells: string[]) => [...cells, ...Array<string>(width - cells.length).fill("")];
    const extra = [
      row(["Oskar", "Lindkvist", oskarBorn, "Pojke"]).join(";"),
      row(["Tove", "Ek", "", "Flicka"]).join(";"),
    ].join("\r\n");
    await s.imports.importFile(karin, Buffer.from(`${sample.trimEnd()}\r\n${extra}\r\n`, "utf8"), {
      id: DEMO_IMPORT_IDS.ikn,
      options: { consentNote: "Medlemsansökningar 2025", sendInvitations: true },
    });
  },
};
