// SPDX-License-Identifier: AGPL-3.0-only
// Loads and validates the demo data files in docs/demodata/ (ADR 0026): each
// file against its schema from @clubadmin/shared, then every reference
// between them (people, clubs, groups by key).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type DemoClub,
  DemoClubsFileSchema,
  type DemoGroup,
  type DemoHistory,
  DemoHistoryFileSchema,
  type DemoPersona,
  DemoPersonasFileSchema,
  type DemoRelationships,
  DemoRelationshipsFileSchema,
  DemoWaitlistsFileSchema,
  type z,
} from "@clubadmin/shared";

export interface DemoData {
  personas: DemoPersona[];
  clubs: DemoClub[];
  groups: DemoGroup[];
  relationships: DemoRelationships;
  waitlists: z.infer<typeof DemoWaitlistsFileSchema>["entries"];
  history: DemoHistory["changes"];
}

/** docs/demodata/ of the repository this file belongs to (source or dist). */
export function demoDataDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "docs", "demodata");
    if (existsSync(join(candidate, "personas.json"))) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) throw new Error("docs/demodata not found");
    dir = parent;
  }
}

function read<S extends z.ZodType>(dir: string, file: string, schema: S): z.output<S> {
  const raw: unknown = JSON.parse(readFileSync(join(dir, file), "utf8"));
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`docs/demodata/${file} is invalid:\n  ${issues.join("\n  ")}`);
  }
  return result.data;
}

export function loadDemoData(dir: string = demoDataDir()): DemoData {
  const { personas } = read(dir, "personas.json", DemoPersonasFileSchema);
  const { clubs, groups } = read(dir, "clubs.json", DemoClubsFileSchema);
  const data: DemoData = {
    personas,
    clubs,
    groups,
    relationships: read(dir, "relationships.json", DemoRelationshipsFileSchema),
    waitlists: read(dir, "waitlists.json", DemoWaitlistsFileSchema).entries,
    history: read(dir, "history.json", DemoHistoryFileSchema).changes,
  };
  checkReferences(data);
  return data;
}

/** Every key used refers to a defined persona, club or group; IDs and keys are unique. */
function checkReferences(data: DemoData): void {
  const problems: string[] = [];
  const unique = (what: string, values: string[]) => {
    const seen = new Set<string>();
    for (const v of values) {
      if (seen.has(v)) problems.push(`duplicate ${what} ${v}`);
      seen.add(v);
    }
  };
  unique(
    "persona key",
    data.personas.map((p) => p.key),
  );
  unique(
    "persona number",
    data.personas.map((p) => String(p.number)),
  );
  unique(
    "id",
    [...data.personas, ...data.clubs, ...data.groups].map((x) => x.id),
  );
  unique(
    "club or group key",
    [...data.clubs, ...data.groups].map((x) => x.key),
  );

  const people = new Set(data.personas.map((p) => p.key));
  const clubs = new Set(data.clubs.map((c) => c.key));
  const groups = new Set(data.groups.map((g) => g.key));
  const check = (kind: "person" | "club" | "group", value: string | null, where: string) => {
    if (value === null) return;
    const known = kind === "person" ? people : kind === "club" ? clubs : groups;
    if (!known.has(value)) problems.push(`${where}: unknown ${kind} ${value}`);
  };
  for (const p of data.personas) check("person", p.createdBy, `persona ${p.key}`);
  for (const c of data.clubs) {
    check("person", c.foundedBy, `club ${c.key}`);
    check("person", c.actor, `club ${c.key}`);
  }
  for (const g of data.groups) {
    check("club", g.club, `group ${g.key}`);
    check("group", g.parent, `group ${g.key}`);
    for (const o of g.owners) check("person", o, `group ${g.key} owner`);
    check("person", g.generated?.protectedBy ?? null, `group ${g.key}`);
  }
  const r = data.relationships;
  r.guardianships.forEach((x, i) => {
    for (const k of [x.guardian, x.ward, x.by]) check("person", k, `guardianships[${i}]`);
  });
  r.memberships.forEach((x, i) => {
    for (const k of [x.person, x.by]) check("person", k, `memberships[${i}]`);
    check("club", x.club, `memberships[${i}]`);
  });
  r.roles.forEach((x, i) => {
    for (const k of [x.person, x.by]) check("person", k, `roles[${i}]`);
    check("club", x.club, `roles[${i}]`);
  });
  r.groupMemberships.forEach((x, i) => {
    for (const k of [x.person, x.by]) check("person", k, `groupMemberships[${i}]`);
    check("group", x.group, `groupMemberships[${i}]`);
  });
  r.handovers.forEach((x, i) => {
    for (const k of [x.from, x.to]) check("person", k, `handovers[${i}]`);
    check("club", x.club, `handovers[${i}]`);
  });
  for (const x of r.ownLogins) for (const k of [x.person, x.by]) check("person", k, "ownLogins");
  for (const x of [...r.employments, ...r.sharedFields, ...r.consents, ...r.clubProtection]) {
    check("person", x.person, "relationships");
    check("club", x.club, "relationships");
  }
  for (const x of r.joinRequests) {
    for (const k of [x.person, x.requestedBy]) check("person", k, "joinRequests");
    check("club", x.club, "joinRequests");
    for (const g of x.preferredGroups) check("group", g, "joinRequests");
  }
  for (const x of r.invitations) {
    check("club", x.club, "invitations");
    check("person", x.createdBy, "invitations");
    check("group", x.group, "invitations");
  }
  for (const k of r.operators) check("person", k, "operators");
  for (const x of r.supportGrants) {
    for (const k of [x.operator, x.grantedBy]) check("person", k, "supportGrants");
    check("club", x.club, "supportGrants");
  }
  for (const w of data.waitlists) {
    check("group", w.group, "waitlists");
    for (const k of [w.person, w.requestedBy, w.decidedBy]) check("person", k, "waitlists");
  }
  for (const h of data.history) {
    if ("actor" in h) check("person", h.actor, `history ${h.action}`);
    if ("person" in h) check("person", h.person, `history ${h.action}`);
    if (h.action === "group.move") for (const g of [h.from, h.to]) check("group", g, "history");
    if (h.action === "waitlist.offer.expire") check("group", h.group, "history");
    if (h.action === "membership.approve") check("club", h.club, "history");
  }
  if (problems.length > 0)
    throw new Error(`docs/demodata is inconsistent:\n  ${problems.join("\n  ")}`);
}
