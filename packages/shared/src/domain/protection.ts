// SPDX-License-Identifier: AGPL-3.0-only
// Protected identity UI and the profile view log (P1.12, ADR 0022): setting
// the flags, the state the profile shows to whoever may change it, the
// person's access log across clubs and the club's log for club managers.

import { PersonSummarySchema } from "../auth/schemas.ts";
import { z } from "../zod.ts";
import { CLUB_ROLES, PROFILE_VIEW_LOGGING_MODES, PROFILE_VIEW_SURFACES } from "./core.ts";

export const SetProtectionSchema = z
  .object({ protected: z.boolean() })
  .strict()
  .openapi("SetProtection");
export type SetProtectionInput = z.infer<typeof SetProtectionSchema>;

/** `clubId`: the club flag (club managers, with a second factor). */
export const ProtectionQuerySchema = z.object({ clubId: z.uuid().optional() });

/**
 * The protection of a person as the profile shows it to those who may change
 * it (the person, full guardians, and with `clubId` club managers).
 */
export const ProtectionStateSchema = z
  .object({
    global: z.boolean(),
    globalSetAt: z.iso.datetime().nullable(),
    /** With `clubId`: the club flag. */
    club: z.boolean().nullable(),
    clubSetAt: z.iso.datetime().nullable(),
    /** Who set the club flag (club managers only). */
    clubSetBy: PersonSummarySchema.nullable(),
    canChangeGlobal: z.boolean(),
    /** False when the removal rule refuses the caller (another guardian set it, or below consent age). */
    canRemoveGlobal: z.boolean(),
    canChangeClub: z.boolean(),
  })
  .openapi("ProtectionState");
export type ProtectionState = z.infer<typeof ProtectionStateSchema>;

export const ProfileViewLoggingSchema = z
  .object({ mode: z.enum(PROFILE_VIEW_LOGGING_MODES) })
  .strict()
  .openapi("ProfileViewLogging");
export type ProfileViewLoggingInput = z.infer<typeof ProfileViewLoggingSchema>;

/**
 * Who opened a profile: a person the reader may see, someone with protected
 * identity, a platform operator, or a former member (anonymised).
 */
export const ProfileViewerSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("person"), person: PersonSummarySchema }),
    z.object({ kind: z.literal("protected") }),
    z.object({ kind: z.literal("operator") }),
    z.object({ kind: z.literal("former_member") }),
  ])
  .openapi("ProfileViewer");
export type ProfileViewer = z.infer<typeof ProfileViewerSchema>;

/** The relationship that allowed the view, computed when the log is read. */
export const PROFILE_VIEWER_ROLES = [...CLUB_ROLES, "group_leader", "guardian", "member"] as const;
export type ProfileViewerRole = (typeof PROFILE_VIEWER_ROLES)[number];

export const ProfileViewEntrySchema = z
  .object({
    id: z.uuid(),
    day: z.iso.date(),
    firstViewedAt: z.iso.datetime(),
    lastViewedAt: z.iso.datetime(),
    count: z.number().int(),
    surface: z.enum(PROFILE_VIEW_SURFACES),
    /** The viewed person was protected at the time. */
    protected: z.boolean(),
    club: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    viewer: ProfileViewerSchema,
    onBehalfOf: PersonSummarySchema.nullable(),
    viewerRole: z.enum(PROFILE_VIEWER_ROLES).nullable(),
    /** The club log only: whose profile. */
    person: ProfileViewerSchema.optional(),
  })
  .openapi("ProfileViewEntry");
export type ProfileViewEntry = z.infer<typeof ProfileViewEntrySchema>;

export const ProfileViewPageSchema = z
  .object({ items: z.array(ProfileViewEntrySchema), nextCursor: z.uuid().nullable() })
  .openapi("ProfileViewPage");
export type ProfileViewPage = z.infer<typeof ProfileViewPageSchema>;

export const AccessLogQuerySchema = z.object({ cursor: z.uuid().optional() });

export const ClubProfileViewsQuerySchema = z.object({
  cursor: z.uuid().optional(),
  personId: z.uuid().optional(),
  viewerId: z.uuid().optional(),
  protected: z.enum(["only"]).optional(),
});
export type ClubProfileViewsQuery = z.infer<typeof ClubProfileViewsQuerySchema>;

export const ClubProfileViewsSchema = ProfileViewPageSchema.extend({
  mode: z.enum(PROFILE_VIEW_LOGGING_MODES),
}).openapi("ClubProfileViews");
export type ClubProfileViews = z.infer<typeof ClubProfileViewsSchema>;
