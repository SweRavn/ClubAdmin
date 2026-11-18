// SPDX-License-Identifier: AGPL-3.0-only
// The data a plugin is given (ADR 0051 decision 3): people and sessions as
// plain JSON, with only the fields its manifest declares. People and groups
// are named by the host's IDs; the plugin never sees anything it did not ask
// for, and never a database.

import { z } from "@clubadmin/shared";

import type { DataField } from "./manifest.ts";

const day = z.iso.date();

/** A person as a plugin may see them; every field but `id` depends on the manifest. */
export const PluginPersonSchema = z
  .object({
    id: z.uuid(),
    /** `name` */
    givenName: z.string().optional(),
    familyName: z.string().optional(),
    /** `birthDate` (null: unknown) */
    birthDate: day.nullable().optional(),
    /** `sex` (null: unknown) */
    sex: z.enum(["female", "male", "other"]).nullable().optional(),
    /** `personalIdentityNumber`, decrypted by the host for this call (null: none). */
    personalIdentityNumber: z.string().nullable().optional(),
    /** `disability`: takes part in an adapted group of the club. */
    disability: z.boolean().optional(),
    /** `homeMunicipality`: the municipality code (null: unknown). */
    homeMunicipality: z.string().nullable().optional(),
    /** `membershipStatus`: the person's membership of the club (null: not a member). */
    membership: z
      .object({
        status: z.enum(["active", "paused", "left"]),
        /** `active` members take part; supporting, honorary and family members are `passive`. */
        type: z.enum(["active", "passive"]),
        joinedOn: day.nullable(),
        leftOn: day.nullable(),
      })
      .nullable()
      .optional(),
    /** `membershipFeePaid` for the current year (null: the club does not track fees). */
    membershipFeePaid: z.boolean().nullable().optional(),
    /** `clubRoles`: the keys of the person's club roles. */
    clubRoles: z.array(z.string()).optional(),
    /** `groupRoles` and `groupSport`: the person's groups, their function and sport. */
    groups: z
      .array(
        z.object({
          groupId: z.uuid(),
          functions: z.array(z.string()),
          sport: z.string().nullable().optional(),
          adapted: z.boolean().optional(),
        }),
      )
      .optional(),
  })
  .strict();
export type PluginPerson = z.infer<typeof PluginPersonSchema>;

/** One held session (an activity that took place) with who was there. */
export const PluginSessionSchema = z
  .object({
    id: z.uuid(),
    groupId: z.uuid(),
    /** `groupSport` (null: not set on the group). */
    sport: z.string().nullable().optional(),
    /** The group is adapted (parasport, adapted activities). */
    adapted: z.boolean().optional(),
    kind: z.enum(["training", "match", "meeting", "other"]),
    /** The local date in the club's time zone. */
    date: day,
    startsAt: z.iso.datetime(),
    durationMinutes: z.number().int().min(0),
    /** `attendance`: participants present. */
    participantIds: z.array(z.uuid()).optional(),
    /** `leaders`: leaders present (appointed in the group). */
    leaderIds: z.array(z.uuid()).optional(),
  })
  .strict();
export type PluginSession = z.infer<typeof PluginSessionSchema>;

const PERSON_FIELDS: Record<DataField, readonly (keyof PluginPerson)[]> = {
  name: ["givenName", "familyName"],
  birthDate: ["birthDate"],
  sex: ["sex"],
  personalIdentityNumber: ["personalIdentityNumber"],
  disability: ["disability"],
  homeMunicipality: ["homeMunicipality"],
  membershipStatus: ["membership"],
  membershipFeePaid: ["membershipFeePaid"],
  groupSport: ["groups"],
  attendance: [],
  leaders: [],
  clubRoles: ["clubRoles"],
  groupRoles: ["groups"],
};

/** The person's fields a manifest's declaration allows. */
export function allowedPersonFields(declared: readonly DataField[]): Set<keyof PluginPerson> {
  return new Set<keyof PluginPerson>(["id", ...declared.flatMap((d) => PERSON_FIELDS[d])]);
}

/** A person with only the declared fields (the host calls this before every call). */
export function minimizePerson(person: PluginPerson, declared: readonly DataField[]): PluginPerson {
  const allowed = allowedPersonFields(declared);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(person)) {
    if (allowed.has(key as keyof PluginPerson) && value !== undefined) out[key] = value;
  }
  if (out.groups && Array.isArray(out.groups)) {
    const sport = declared.includes("groupSport");
    const roles = declared.includes("groupRoles");
    const adapted = declared.includes("disability");
    out.groups = (person.groups ?? []).map((g) => ({
      groupId: g.groupId,
      functions: roles ? g.functions : [],
      ...(sport && g.sport !== undefined ? { sport: g.sport } : {}),
      ...(adapted && g.adapted !== undefined ? { adapted: g.adapted } : {}),
    }));
  }
  return out as PluginPerson;
}

/** A session with only the declared fields. */
export function minimizeSession(
  session: PluginSession,
  declared: readonly DataField[],
): PluginSession {
  const { sport, adapted, participantIds, leaderIds, ...rest } = session;
  return {
    ...rest,
    ...(declared.includes("groupSport") && sport !== undefined ? { sport } : {}),
    ...(declared.includes("disability") && adapted !== undefined ? { adapted } : {}),
    ...(declared.includes("attendance") && participantIds ? { participantIds } : {}),
    ...(declared.includes("leaders") && leaderIds ? { leaderIds } : {}),
  };
}
