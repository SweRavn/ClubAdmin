// SPDX-License-Identifier: AGPL-3.0-only
// Group administration (P1.10a): owners, seasons and per-season capacity,
// adding and ending members, the candidate search for owners, archiving a
// group with people in it.

import { PersonSummarySchema } from "../auth/schemas.ts";
import { z } from "../zod.ts";
import { GROUP_FUNCTIONS } from "./core.ts";
import { GroupSchema } from "./responses.ts";

export const GroupOwnerParamsSchema = z.object({ groupId: z.uuid(), personId: z.uuid() });

export const AddGroupOwnerSchema = z.object({ personId: z.uuid() }).openapi("AddGroupOwner");
export type AddGroupOwnerInput = z.infer<typeof AddGroupOwnerSchema>;

export const SeasonSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    startsOn: z.iso.date(),
    endsOn: z.iso.date(),
  })
  .openapi("Season");
export type SeasonResponse = z.infer<typeof SeasonSchema>;

export const SeasonListSchema = z.object({ items: z.array(SeasonSchema) }).openapi("SeasonList");
export type SeasonList = z.infer<typeof SeasonListSchema>;

export const CreateSeasonSchema = z
  .object({
    name: z.string().trim().min(1).max(50),
    startsOn: z.iso.date(),
    endsOn: z.iso.date(),
  })
  .refine((s) => s.endsOn > s.startsOn, { message: "endsOn after startsOn", path: ["endsOn"] })
  .openapi("CreateSeason");
export type CreateSeasonInput = z.infer<typeof CreateSeasonSchema>;

export const GroupSeasonParamsSchema = z.object({ groupId: z.uuid(), seasonId: z.uuid() });

export const PutGroupSeasonSchema = z
  .object({
    /** Places this season; null: the group's own capacity. */
    capacity: z.number().int().min(1).max(10_000).nullable(),
    notes: z.string().trim().max(500).nullable().optional(),
  })
  .openapi("PutGroupSeason");
export type PutGroupSeasonInput = z.infer<typeof PutGroupSeasonSchema>;

export const GroupSeasonSchema = z
  .object({
    seasonId: z.uuid(),
    capacity: z.number().int().nullable(),
    notes: z.string().nullable(),
  })
  .openapi("GroupSeason");
export type GroupSeasonResponse = z.infer<typeof GroupSeasonSchema>;

export const GroupSeasonListSchema = z
  .object({ items: z.array(GroupSeasonSchema) })
  .openapi("GroupSeasonList");
export type GroupSeasonList = z.infer<typeof GroupSeasonListSchema>;

/** At most this many candidates per page. */
export const GROUP_CANDIDATES_MAX = 20;

export const GroupCandidatesQuerySchema = z.object({
  /** Part of the name, or a member number. */
  q: z.string().trim().min(2).max(100),
  /** Leave out those who hold this function in the group; without it, nobody is left out (owners). */
  function: z.enum(GROUP_FUNCTIONS).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(GROUP_CANDIDATES_MAX).default(GROUP_CANDIDATES_MAX),
});
export type GroupCandidatesQuery = z.infer<typeof GroupCandidatesQuerySchema>;

export const GroupCandidateListSchema = z
  .object({
    items: z.array(
      z.object({
        person: PersonSummarySchema,
        birthYear: z.number().int().nullable(),
        memberNumber: z.number().int().nullable(),
      }),
    ),
    nextCursor: z.uuid().nullable(),
  })
  .openapi("GroupCandidateList");
export type GroupCandidateList = z.infer<typeof GroupCandidateListSchema>;

export const AddGroupMemberSchema = z
  .object({
    personId: z.uuid(),
    function: z.enum(GROUP_FUNCTIONS).default("member"),
    /** The club's group role (P1.15 A2); wins over `function`. */
    roleId: z.uuid().optional(),
    /** Add a `member` to a full group anyway (audited). */
    overCapacity: z.boolean().optional(),
    /**
     * Why a `member` is added while people wait (P1.10b; required then,
     * `queue_bypass_reason_required`; audited and listed for club managers).
     */
    queueBypassReason: z.string().trim().min(1).max(500).optional(),
  })
  .openapi("AddGroupMember");
export type AddGroupMemberInput = z.input<typeof AddGroupMemberSchema>;

export const GroupMembershipParamsSchema = z.object({
  groupId: z.uuid(),
  membershipId: z.uuid(),
});

export const GroupMembershipSchema = z
  .object({
    id: z.uuid(),
    personId: z.uuid(),
    function: z.enum(GROUP_FUNCTIONS),
    /** The club's group role (P1.15 A2). */
    roleId: z.uuid().optional(),
  })
  .openapi("GroupMembership");
export type GroupMembershipResponse = z.infer<typeof GroupMembershipSchema>;

/** What archiving a group does (the confirmation dialog). */
export const GroupArchivePreviewSchema = z
  .object({
    /** Open `member` functions that end. */
    members: z.number().int(),
    /** Open leader functions that end. */
    leaders: z.number().int(),
    /** Open waiting-list entries that close (the applicants are told). */
    waitlist: z.number().int(),
    /** Child groups that are not archived: archiving is refused while there are any. */
    activeChildren: z.number().int(),
  })
  .openapi("GroupArchivePreview");
export type GroupArchivePreview = z.infer<typeof GroupArchivePreviewSchema>;

export const GroupArchiveResultSchema = GroupSchema.extend({
  /** What the archiving ended and closed (zero if it was already archived). */
  ended: z.object({
    members: z.number().int(),
    leaders: z.number().int(),
    waitlist: z.number().int(),
  }),
}).openapi("GroupArchiveResult");
export type GroupArchiveResult = z.infer<typeof GroupArchiveResultSchema>;
