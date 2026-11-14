// SPDX-License-Identifier: AGPL-3.0-only
// Announcements (P2.3, ADR 0053): one message from the club or a group to an
// audience (ADR 0049), on the board, by push and/or by email. Push carries
// no free text; the body is Markdown limited to what the shared renderer
// shows (paragraphs, emphasis, lists, links). People appear only as
// PersonSummary from the presenter (ADR 0022).

import { PersonSummarySchema } from "../auth/schemas.ts";
import { z } from "../zod.ts";
import {
  AUDIENCE_MAX_ENTRIES,
  AudienceEntryInputSchema,
  AudienceEntrySchema,
} from "./documents.ts";

export const ANNOUNCEMENT_CHANNELS = ["board", "push", "email"] as const;
export type AnnouncementChannel = (typeof ANNOUNCEMENT_CHANNELS)[number];

export const ANNOUNCEMENT_STATUSES = ["draft", "scheduled", "sent", "withdrawn"] as const;
export type AnnouncementStatus = (typeof ANNOUNCEMENT_STATUSES)[number];

export const ANNOUNCEMENT_TITLE_MAX = 150;
export const ANNOUNCEMENT_BODY_MAX = 10_000;
/** Pinned ones on the board at most (the newest first). */
export const ANNOUNCEMENT_PINNED_MAX = 10;

export const AnnouncementParamsSchema = z.object({ clubId: z.uuid(), announcementId: z.uuid() });
export const GroupAnnouncementsParamsSchema = z.object({ clubId: z.uuid(), groupId: z.uuid() });

/** An audience for an announcement: as ADR 0049, but never public (Phase 3). */
export const AnnouncementAudienceSchema = z
  .array(AudienceEntryInputSchema)
  .min(1)
  .max(AUDIENCE_MAX_ENTRIES)
  .refine((entries) => entries.every((e) => e.kind !== "public"), {
    message: "public_not_allowed",
  })
  .openapi("AnnouncementAudience");
export type AnnouncementAudienceInput = z.infer<typeof AnnouncementAudienceSchema>;

const channels = z
  .array(z.enum(ANNOUNCEMENT_CHANNELS))
  .min(1)
  .max(3)
  .refine((list) => new Set(list).size === list.length, { message: "duplicate_channel" });

const title = z.string().trim().min(1).max(ANNOUNCEMENT_TITLE_MAX);
const body = z.string().trim().min(1).max(ANNOUNCEMENT_BODY_MAX);

/**
 * A new announcement: a draft (`send` false), sent now (`send` true without
 * `scheduledAt`) or scheduled (`send` true with a future `scheduledAt`).
 * Without an audience a group's goes to the group, the club's to the club.
 */
export const CreateAnnouncementSchema = z
  .object({
    title,
    body,
    audience: AnnouncementAudienceSchema.optional(),
    channels,
    important: z.boolean().default(false),
    pinnedUntil: z.iso.datetime({ offset: true }).nullish(),
    expiresAt: z.iso.datetime({ offset: true }).nullish(),
    scheduledAt: z.iso.datetime({ offset: true }).nullish(),
    send: z.boolean().default(false),
  })
  .strict()
  .openapi("CreateAnnouncement");
export type CreateAnnouncementInput = z.infer<typeof CreateAnnouncementSchema>;

/**
 * Changes: before sending everything (and `send` to send or schedule a
 * draft); after sending only the title, body, pin and expiry (marked
 * edited; emails already sent are not changed).
 */
export const UpdateAnnouncementSchema = z
  .object({
    title: title.optional(),
    body: body.optional(),
    audience: AnnouncementAudienceSchema.optional(),
    channels: channels.optional(),
    important: z.boolean().optional(),
    pinnedUntil: z.iso.datetime({ offset: true }).nullish(),
    expiresAt: z.iso.datetime({ offset: true }).nullish(),
    scheduledAt: z.iso.datetime({ offset: true }).nullish(),
    send: z.boolean().optional(),
  })
  .strict()
  .openapi("UpdateAnnouncement");
export type UpdateAnnouncementInput = z.infer<typeof UpdateAnnouncementSchema>;

export const AnnouncementSchema = z
  .object({
    id: z.uuid(),
    clubId: z.uuid(),
    clubName: z.string(),
    /** The group whose announcement it is (none: the club's). */
    groupId: z.uuid().nullable(),
    groupName: z.string().nullable(),
    title: z.string(),
    /** Markdown (paragraphs, emphasis, lists, links). */
    body: z.string(),
    channels: z.array(z.enum(ANNOUNCEMENT_CHANNELS)),
    important: z.boolean(),
    status: z.enum(ANNOUNCEMENT_STATUSES),
    /** Pinned on the board now. */
    pinned: z.boolean(),
    pinnedUntil: z.iso.datetime().nullable(),
    expiresAt: z.iso.datetime().nullable(),
    scheduledAt: z.iso.datetime().nullable(),
    sentAt: z.iso.datetime().nullable(),
    editedAt: z.iso.datetime().nullable(),
    /** None: hidden (protected identity) or no longer known. */
    sender: PersonSummarySchema.nullable(),
    /** The caller (or for a guardian, they) read it. */
    read: z.boolean(),
    canManage: z.boolean(),
  })
  .openapi("Announcement");
export type Announcement = z.infer<typeof AnnouncementSchema>;

/** One announcement with its audience (who it goes to, groups and roles by name). */
export const AnnouncementDetailSchema = z
  .object({ announcement: AnnouncementSchema, audience: z.array(AudienceEntrySchema) })
  .openapi("AnnouncementDetail");
export type AnnouncementDetail = z.infer<typeof AnnouncementDetailSchema>;

/** "Anslagstavlan": pinned ones first (on the first page), then the newest, keyset. */
export const AnnouncementBoardSchema = z
  .object({
    pinned: z.array(AnnouncementSchema),
    items: z.array(AnnouncementSchema),
    nextCursor: z.uuid().nullable(),
  })
  .openapi("AnnouncementBoard");
export type AnnouncementBoard = z.infer<typeof AnnouncementBoardSchema>;

export const AnnouncementBoardQuerySchema = z.object({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type AnnouncementBoardQuery = z.infer<typeof AnnouncementBoardQuerySchema>;

/** The club's archive: drafts, scheduled, sent and withdrawn, newest first. */
export const AnnouncementArchiveSchema = z
  .object({ items: z.array(AnnouncementSchema), nextCursor: z.uuid().nullable() })
  .openapi("AnnouncementArchive");
export type AnnouncementArchive = z.infer<typeof AnnouncementArchiveSchema>;

export const AnnouncementCreatedSchema = z.object({ id: z.uuid() }).openapi("AnnouncementCreated");

const deliveryCounts = z.object({
  queued: z.number().int(),
  sent: z.number().int(),
  skipped: z.number().int(),
  failed: z.number().int(),
});

/** What happened to a sent announcement: counts, never names. */
export const AnnouncementRecipientsSchema = z
  .object({
    /** The people the audience included when sent (none before sending). */
    recipients: z.number().int().nullable(),
    read: z.number().int(),
    push: deliveryCounts,
    email: deliveryCounts,
  })
  .openapi("AnnouncementRecipients");
export type AnnouncementRecipients = z.infer<typeof AnnouncementRecipientsSchema>;

/** The composer's counts for an audience before sending. */
export const AnnouncementPreviewInputSchema = z
  .object({ audience: AnnouncementAudienceSchema })
  .strict()
  .openapi("AnnouncementPreviewInput");
export type AnnouncementPreviewInput = z.infer<typeof AnnouncementPreviewInputSchema>;

export const AnnouncementPreviewSchema = z
  .object({
    /** People in the audience (with guardians who receive messages). */
    recipients: z.number().int(),
    /** Of them, with an email address. */
    withEmail: z.number().int(),
    /** Of them, with the app (push). */
    withApp: z.number().int(),
  })
  .openapi("AnnouncementPreview");
export type AnnouncementPreview = z.infer<typeof AnnouncementPreviewSchema>;
