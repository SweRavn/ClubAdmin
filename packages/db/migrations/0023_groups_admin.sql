-- SPDX-License-Identifier: AGPL-3.0-only
-- P1.10a: why a waiting-list entry closed (archiving a group, leaving a club;
-- P1.10b adds the rest of the waiting-list flow). A code, never free text.
-- Existing closed entries keep NULL (closed before the reason was recorded).
ALTER TABLE "group_waitlist_entries" ADD COLUMN "closed_reason" text;--> statement-breakpoint
ALTER TABLE "group_waitlist_entries" ADD CONSTRAINT "group_waitlist_entries_closed_reason" CHECK ("group_waitlist_entries"."closed_reason" IS NULL OR "group_waitlist_entries"."closed_reason" IN ('declined', 'expired', 'withdrawn', 'removed_by_owner', 'join_request_rejected', 'left_club', 'group_archived'));
