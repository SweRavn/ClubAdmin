CREATE TABLE "club_manager_handovers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"club_id" uuid NOT NULL,
	"from_person_id" uuid NOT NULL,
	"to_person_id" uuid NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_manager_handovers_status" CHECK ("club_manager_handovers"."status" IN ('proposed', 'accepted', 'declined', 'cancelled')),
	CONSTRAINT "club_manager_handovers_not_self" CHECK ("club_manager_handovers"."from_person_id" <> "club_manager_handovers"."to_person_id")
);
--> statement-breakpoint
CREATE TABLE "club_memberships" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"club_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"status" text NOT NULL,
	"membership_type" text DEFAULT 'active' NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_memberships_status" CHECK ("club_memberships"."status" IN ('applied', 'active', 'paused', 'left')),
	CONSTRAINT "club_memberships_type" CHECK ("club_memberships"."membership_type" IN ('active', 'supporting', 'honorary', 'family')),
	CONSTRAINT "club_memberships_valid_period" CHECK ("club_memberships"."valid_to" IS NULL OR "club_memberships"."valid_to" > "club_memberships"."valid_from"),
	CONSTRAINT "club_memberships_left_has_valid_to" CHECK (("club_memberships"."status" = 'left') = ("club_memberships"."valid_to" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "club_profiles" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"club_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"member_number" integer DEFAULT NULL NOT NULL,
	"shared_fields" text[] DEFAULT '{}' NOT NULL,
	"emergency_contacts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"protected_identity_club" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_profiles_person_unique" UNIQUE("club_id","person_id"),
	CONSTRAINT "club_profiles_member_number_unique" UNIQUE("club_id","member_number"),
	CONSTRAINT "club_profiles_shared_fields" CHECK ("club_profiles"."shared_fields" <@ ARRAY['phone', 'address', 'personal_identity_number', 'gender']::text[]),
	CONSTRAINT "club_profiles_member_number" CHECK ("club_profiles"."member_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "club_role_assignments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"club_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"role" text NOT NULL,
	"assigned_by_person_id" uuid,
	"ended_by_person_id" uuid,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_role_assignments_role" CHECK ("club_role_assignments"."role" IN ('chair', 'vice_chair', 'treasurer', 'secretary', 'board_member', 'deputy_board_member', 'auditor', 'nomination_committee', 'club_manager', 'registrar', 'safeguarding_officer', 'communications', 'staff')),
	CONSTRAINT "club_role_assignments_valid_period" CHECK ("club_role_assignments"."valid_to" IS NULL OR "club_role_assignments"."valid_to" > "club_role_assignments"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "clubs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"short_name" text,
	"slug" text NOT NULL,
	"country" text NOT NULL,
	"default_locale" text NOT NULL,
	"time_zone" text NOT NULL,
	"currency" text NOT NULL,
	"organization_number" text,
	"federation_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"address" jsonb,
	"logo" text,
	"status" text DEFAULT 'active' NOT NULL,
	"join_policy" text DEFAULT 'approval' NOT NULL,
	"next_member_number" integer DEFAULT 1 NOT NULL,
	"owners_can_appoint_co_owners" boolean DEFAULT false NOT NULL,
	"group_owners_admit_to_club" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clubs_status" CHECK ("clubs"."status" IN ('active', 'suspended', 'archived')),
	CONSTRAINT "clubs_join_policy" CHECK ("clubs"."join_policy" IN ('open', 'approval', 'invite_only')),
	CONSTRAINT "clubs_country" CHECK ("clubs"."country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "clubs_currency" CHECK ("clubs"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "clubs_slug_shape" CHECK ("clubs"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "clubs_next_member_number" CHECK ("clubs"."next_member_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"club_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"text_version" text NOT NULL,
	"given_by_person_id" uuid NOT NULL,
	"given_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_person_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consents_purpose" CHECK ("consents"."purpose" IN ('photo_publication', 'video_publication', 'streaming', 'marketing', 'federation_sharing'))
);
--> statement-breakpoint
CREATE TABLE "employments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"club_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"title" text NOT NULL,
	"employment_type" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"hours_per_week" numeric(5, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employments_type" CHECK ("employments"."employment_type" IN ('permanent', 'fixed_term', 'hourly', 'volunteer_stipend')),
	CONSTRAINT "employments_period" CHECK ("employments"."ends_on" IS NULL OR "employments"."ends_on" >= "employments"."starts_on")
);
--> statement-breakpoint
CREATE TABLE "group_memberships" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"club_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"function" text DEFAULT 'member' NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_memberships_function" CHECK ("group_memberships"."function" IN ('member', 'head_coach', 'assistant_coach', 'team_manager', 'physio', 'other_leader')),
	CONSTRAINT "group_memberships_valid_period" CHECK ("group_memberships"."valid_to" IS NULL OR "group_memberships"."valid_to" > "group_memberships"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "group_owners" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"club_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"assigned_by_person_id" uuid,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_owners_valid_period" CHECK ("group_owners"."valid_to" IS NULL OR "group_owners"."valid_to" > "group_owners"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "group_seasons" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"club_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"season_id" uuid NOT NULL,
	"capacity" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_seasons_unique" UNIQUE("group_id","season_id"),
	CONSTRAINT "group_seasons_capacity" CHECK ("group_seasons"."capacity" IS NULL OR "group_seasons"."capacity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"club_id" uuid NOT NULL,
	"parent_group_id" uuid,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"sport" text,
	"birth_year_from" smallint,
	"birth_year_to" smallint,
	"gender_category" text,
	"level" text,
	"capacity" integer,
	"admission_mode" text DEFAULT 'direct' NOT NULL,
	"waitlist_visible_publicly" boolean DEFAULT false NOT NULL,
	"offer_reply_days" smallint DEFAULT 7 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "groups_club_id_unique" UNIQUE("club_id","id"),
	CONSTRAINT "groups_kind" CHECK ("groups"."kind" IN ('section', 'team', 'training_group', 'age_group', 'committee', 'board', 'volunteers', 'other')),
	CONSTRAINT "groups_admission_mode" CHECK ("groups"."admission_mode" IN ('direct', 'waitlist', 'closed')),
	CONSTRAINT "groups_gender_category" CHECK ("groups"."gender_category" IS NULL OR "groups"."gender_category" IN ('female', 'male', 'mixed', 'open')),
	CONSTRAINT "groups_not_own_parent" CHECK ("groups"."parent_group_id" <> "groups"."id"),
	CONSTRAINT "groups_birth_years" CHECK ("groups"."birth_year_from" IS NULL OR "groups"."birth_year_to" IS NULL OR "groups"."birth_year_to" >= "groups"."birth_year_from"),
	CONSTRAINT "groups_capacity" CHECK ("groups"."capacity" IS NULL OR "groups"."capacity" >= 0),
	CONSTRAINT "groups_offer_reply_days" CHECK ("groups"."offer_reply_days" BETWEEN 1 AND 60)
);
--> statement-breakpoint
CREATE TABLE "seasons" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"club_id" uuid NOT NULL,
	"name" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seasons_club_id_unique" UNIQUE("club_id","id"),
	CONSTRAINT "seasons_period" CHECK ("seasons"."ends_on" > "seasons"."starts_on")
);
--> statement-breakpoint
CREATE TABLE "group_waitlist_entries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"club_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"requested_by_person_id" uuid NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"priority" smallint DEFAULT 0 NOT NULL,
	"offer_expires_at" timestamp with time zone,
	"applicant_note" text,
	"owner_note" text,
	"out_of_order_reason" text,
	"decided_by_person_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_waitlist_entries_status" CHECK ("group_waitlist_entries"."status" IN ('waiting', 'offered', 'accepted', 'declined', 'expired', 'admitted', 'withdrawn', 'removed')),
	CONSTRAINT "group_waitlist_entries_offer" CHECK (("group_waitlist_entries"."status" = 'offered') <= ("group_waitlist_entries"."offer_expires_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"club_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"email" text,
	"token_hash" text NOT NULL,
	"role_preset" text,
	"group_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"max_uses" integer,
	"uses" integer DEFAULT 0 NOT NULL,
	"created_by_person_id" uuid NOT NULL,
	"accepted_by_person_id" uuid,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_kind" CHECK ("invitations"."kind" IN ('email', 'link', 'code')),
	CONSTRAINT "invitations_email" CHECK (("invitations"."kind" = 'email') = ("invitations"."email" IS NOT NULL)),
	CONSTRAINT "invitations_role_preset" CHECK ("invitations"."role_preset" IS NULL OR "invitations"."role_preset" IN ('chair', 'vice_chair', 'treasurer', 'secretary', 'board_member', 'deputy_board_member', 'auditor', 'nomination_committee', 'club_manager', 'registrar', 'safeguarding_officer', 'communications', 'staff'))
);
--> statement-breakpoint
CREATE TABLE "join_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"club_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"requested_by_person_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"message" text,
	"preferred_group_ids" uuid[] DEFAULT '{}' NOT NULL,
	"decided_by_person_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "join_requests_status" CHECK ("join_requests"."status" IN ('pending', 'approved', 'rejected', 'withdrawn'))
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"person_id" uuid NOT NULL,
	"email" text NOT NULL,
	"email_verified_at" timestamp with time zone NOT NULL,
	"idp_subject" text,
	"locale" text,
	"time_zone" text,
	"theme" text,
	"notification_settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_email_normalised" CHECK ("accounts"."email" = lower(btrim("accounts"."email"))),
	CONSTRAINT "accounts_email_shape" CHECK ("accounts"."email" ~ '^[^@\s]+@[^@\s]+$'),
	CONSTRAINT "accounts_theme" CHECK ("accounts"."theme" IS NULL OR "accounts"."theme" IN ('light', 'dark', 'system'))
);
--> statement-breakpoint
CREATE TABLE "guardian_invitations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"ward_person_id" uuid NOT NULL,
	"invited_by_person_id" uuid NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"kind" text NOT NULL,
	"rights" text[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_person_id" uuid,
	"guardianship_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guardian_invitations_kind" CHECK ("guardian_invitations"."kind" IN ('parent', 'legal_guardian', 'relative', 'contact_person')),
	CONSTRAINT "guardian_invitations_rights" CHECK ("guardian_invitations"."rights" <@ ARRAY['act_on_behalf', 'receive_messages', 'view_schedule', 'sign_up', 'see_medical']::text[]),
	CONSTRAINT "guardian_invitations_email_normalised" CHECK ("guardian_invitations"."email" = lower(btrim("guardian_invitations"."email")))
);
--> statement-breakpoint
CREATE TABLE "guardianships" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"guardian_person_id" uuid NOT NULL,
	"ward_person_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"rights" text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	"created_by_person_id" uuid,
	"ward_adult_flagged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guardianships_kind" CHECK ("guardianships"."kind" IN ('parent', 'legal_guardian', 'relative', 'contact_person')),
	CONSTRAINT "guardianships_rights" CHECK ("guardianships"."rights" <@ ARRAY['act_on_behalf', 'receive_messages', 'view_schedule', 'sign_up', 'see_medical']::text[]),
	CONSTRAINT "guardianships_status" CHECK ("guardianships"."status" IN ('pending', 'active', 'ended')),
	CONSTRAINT "guardianships_not_self" CHECK ("guardianships"."guardian_person_id" <> "guardianships"."ward_person_id"),
	CONSTRAINT "guardianships_valid_period" CHECK ("guardianships"."valid_to" IS NULL OR "guardianships"."valid_to" > "guardianships"."valid_from"),
	CONSTRAINT "guardianships_ended_has_valid_to" CHECK (("guardianships"."status" = 'ended') = ("guardianships"."valid_to" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"given_name" text NOT NULL,
	"family_name" text NOT NULL,
	"birth_date" date NOT NULL,
	"gender" text,
	"personal_identity_number" text,
	"personal_identity_number_hash" text,
	"protected_identity" boolean DEFAULT false NOT NULL,
	"phone" text,
	"address" jsonb,
	"deceased_at" timestamp with time zone,
	"anonymized_at" timestamp with time zone,
	"merged_into_person_id" uuid,
	"created_by_person_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "people_protected_no_address" CHECK (NOT "people"."protected_identity" OR "people"."address" IS NULL),
	CONSTRAINT "people_gender" CHECK ("people"."gender" IS NULL OR "people"."gender" IN ('female', 'male', 'other')),
	CONSTRAINT "people_pin_with_hash" CHECK (("people"."personal_identity_number" IS NULL) = ("people"."personal_identity_number_hash" IS NULL)),
	CONSTRAINT "people_not_merged_into_self" CHECK ("people"."merged_into_person_id" <> "people"."id")
);
--> statement-breakpoint
CREATE TABLE "people_merges" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kept_person_id" uuid NOT NULL,
	"merged_person_id" uuid NOT NULL,
	"merged_by_person_id" uuid,
	"undo_until" timestamp with time zone NOT NULL,
	"undone_at" timestamp with time zone,
	"undone_by_person_id" uuid,
	"moved_references" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "club_manager_handovers" ADD CONSTRAINT "club_manager_handovers_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_manager_handovers" ADD CONSTRAINT "club_manager_handovers_from_person_id_people_id_fk" FOREIGN KEY ("from_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_manager_handovers" ADD CONSTRAINT "club_manager_handovers_to_person_id_people_id_fk" FOREIGN KEY ("to_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_memberships" ADD CONSTRAINT "club_memberships_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_memberships" ADD CONSTRAINT "club_memberships_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_profiles" ADD CONSTRAINT "club_profiles_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_profiles" ADD CONSTRAINT "club_profiles_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_role_assignments" ADD CONSTRAINT "club_role_assignments_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_role_assignments" ADD CONSTRAINT "club_role_assignments_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_role_assignments" ADD CONSTRAINT "club_role_assignments_assigned_by_person_id_people_id_fk" FOREIGN KEY ("assigned_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_role_assignments" ADD CONSTRAINT "club_role_assignments_ended_by_person_id_people_id_fk" FOREIGN KEY ("ended_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_given_by_person_id_people_id_fk" FOREIGN KEY ("given_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_revoked_by_person_id_people_id_fk" FOREIGN KEY ("revoked_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employments" ADD CONSTRAINT "employments_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employments" ADD CONSTRAINT "employments_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_group_fk" FOREIGN KEY ("club_id","group_id") REFERENCES "public"."groups"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_owners" ADD CONSTRAINT "group_owners_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_owners" ADD CONSTRAINT "group_owners_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_owners" ADD CONSTRAINT "group_owners_assigned_by_person_id_people_id_fk" FOREIGN KEY ("assigned_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_owners" ADD CONSTRAINT "group_owners_group_fk" FOREIGN KEY ("club_id","group_id") REFERENCES "public"."groups"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_seasons" ADD CONSTRAINT "group_seasons_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_seasons" ADD CONSTRAINT "group_seasons_group_fk" FOREIGN KEY ("club_id","group_id") REFERENCES "public"."groups"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_seasons" ADD CONSTRAINT "group_seasons_season_fk" FOREIGN KEY ("club_id","season_id") REFERENCES "public"."seasons"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_parent_same_club_fk" FOREIGN KEY ("club_id","parent_group_id") REFERENCES "public"."groups"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seasons" ADD CONSTRAINT "seasons_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_waitlist_entries" ADD CONSTRAINT "group_waitlist_entries_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_waitlist_entries" ADD CONSTRAINT "group_waitlist_entries_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_waitlist_entries" ADD CONSTRAINT "group_waitlist_entries_requested_by_person_id_people_id_fk" FOREIGN KEY ("requested_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_waitlist_entries" ADD CONSTRAINT "group_waitlist_entries_decided_by_person_id_people_id_fk" FOREIGN KEY ("decided_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_waitlist_entries" ADD CONSTRAINT "group_waitlist_entries_group_fk" FOREIGN KEY ("club_id","group_id") REFERENCES "public"."groups"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_created_by_person_id_people_id_fk" FOREIGN KEY ("created_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_by_person_id_people_id_fk" FOREIGN KEY ("accepted_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_group_fk" FOREIGN KEY ("club_id","group_id") REFERENCES "public"."groups"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_requested_by_person_id_people_id_fk" FOREIGN KEY ("requested_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_requests" ADD CONSTRAINT "join_requests_decided_by_person_id_people_id_fk" FOREIGN KEY ("decided_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardian_invitations" ADD CONSTRAINT "guardian_invitations_ward_person_id_people_id_fk" FOREIGN KEY ("ward_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardian_invitations" ADD CONSTRAINT "guardian_invitations_invited_by_person_id_people_id_fk" FOREIGN KEY ("invited_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardian_invitations" ADD CONSTRAINT "guardian_invitations_accepted_by_person_id_people_id_fk" FOREIGN KEY ("accepted_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardian_invitations" ADD CONSTRAINT "guardian_invitations_guardianship_id_guardianships_id_fk" FOREIGN KEY ("guardianship_id") REFERENCES "public"."guardianships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardianships" ADD CONSTRAINT "guardianships_guardian_person_id_people_id_fk" FOREIGN KEY ("guardian_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardianships" ADD CONSTRAINT "guardianships_ward_person_id_people_id_fk" FOREIGN KEY ("ward_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardianships" ADD CONSTRAINT "guardianships_created_by_person_id_people_id_fk" FOREIGN KEY ("created_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_merged_into_person_id_people_id_fk" FOREIGN KEY ("merged_into_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_created_by_person_id_people_id_fk" FOREIGN KEY ("created_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people_merges" ADD CONSTRAINT "people_merges_kept_person_id_people_id_fk" FOREIGN KEY ("kept_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people_merges" ADD CONSTRAINT "people_merges_merged_person_id_people_id_fk" FOREIGN KEY ("merged_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people_merges" ADD CONSTRAINT "people_merges_merged_by_person_id_people_id_fk" FOREIGN KEY ("merged_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people_merges" ADD CONSTRAINT "people_merges_undone_by_person_id_people_id_fk" FOREIGN KEY ("undone_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "club_manager_handovers_open_unique" ON "club_manager_handovers" USING btree ("club_id","from_person_id") WHERE "club_manager_handovers"."status" = 'proposed';--> statement-breakpoint
CREATE INDEX "club_manager_handovers_to_idx" ON "club_manager_handovers" USING btree ("to_person_id") WHERE "club_manager_handovers"."status" = 'proposed';--> statement-breakpoint
CREATE UNIQUE INDEX "club_memberships_open_unique" ON "club_memberships" USING btree ("club_id","person_id") WHERE "club_memberships"."valid_to" IS NULL;--> statement-breakpoint
CREATE INDEX "club_memberships_club_person_idx" ON "club_memberships" USING btree ("club_id","person_id");--> statement-breakpoint
CREATE INDEX "club_memberships_person_active_idx" ON "club_memberships" USING btree ("person_id") WHERE "club_memberships"."valid_to" IS NULL;--> statement-breakpoint
CREATE INDEX "club_profiles_person_idx" ON "club_profiles" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "club_role_assignments_open_unique" ON "club_role_assignments" USING btree ("club_id","person_id","role") WHERE "club_role_assignments"."valid_to" IS NULL;--> statement-breakpoint
CREATE INDEX "club_role_assignments_club_role_idx" ON "club_role_assignments" USING btree ("club_id","role") WHERE "club_role_assignments"."valid_to" IS NULL;--> statement-breakpoint
CREATE INDEX "club_role_assignments_person_idx" ON "club_role_assignments" USING btree ("person_id") WHERE "club_role_assignments"."valid_to" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "clubs_slug_unique" ON "clubs" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "consents_open_unique" ON "consents" USING btree ("club_id","person_id","purpose") WHERE "consents"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "consents_person_idx" ON "consents" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "employments_club_person_idx" ON "employments" USING btree ("club_id","person_id");--> statement-breakpoint
CREATE INDEX "employments_person_idx" ON "employments" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "group_memberships_open_unique" ON "group_memberships" USING btree ("group_id","person_id","function") WHERE "group_memberships"."valid_to" IS NULL;--> statement-breakpoint
CREATE INDEX "group_memberships_group_idx" ON "group_memberships" USING btree ("club_id","group_id") WHERE "group_memberships"."valid_to" IS NULL;--> statement-breakpoint
CREATE INDEX "group_memberships_person_idx" ON "group_memberships" USING btree ("person_id") WHERE "group_memberships"."valid_to" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "group_owners_open_unique" ON "group_owners" USING btree ("group_id","person_id") WHERE "group_owners"."valid_to" IS NULL;--> statement-breakpoint
CREATE INDEX "group_owners_group_idx" ON "group_owners" USING btree ("group_id") WHERE "group_owners"."valid_to" IS NULL;--> statement-breakpoint
CREATE INDEX "group_owners_person_idx" ON "group_owners" USING btree ("person_id") WHERE "group_owners"."valid_to" IS NULL;--> statement-breakpoint
CREATE INDEX "groups_club_idx" ON "groups" USING btree ("club_id","name") WHERE "groups"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "groups_parent_idx" ON "groups" USING btree ("club_id","parent_group_id");--> statement-breakpoint
CREATE INDEX "seasons_club_idx" ON "seasons" USING btree ("club_id","starts_on");--> statement-breakpoint
CREATE UNIQUE INDEX "group_waitlist_entries_open_unique" ON "group_waitlist_entries" USING btree ("group_id","person_id") WHERE "group_waitlist_entries"."status" IN ('waiting', 'offered');--> statement-breakpoint
CREATE INDEX "group_waitlist_entries_order_idx" ON "group_waitlist_entries" USING btree ("group_id","status","priority" DESC NULLS LAST,"queued_at");--> statement-breakpoint
CREATE INDEX "group_waitlist_entries_person_idx" ON "group_waitlist_entries" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_token_unique" ON "invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "invitations_club_idx" ON "invitations" USING btree ("club_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "join_requests_pending_unique" ON "join_requests" USING btree ("club_id","person_id") WHERE "join_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "join_requests_club_status_idx" ON "join_requests" USING btree ("club_id","status","created_at");--> statement-breakpoint
CREATE INDEX "join_requests_person_idx" ON "join_requests" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_person_unique" ON "accounts" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_email_unique" ON "accounts" USING btree (lower(btrim("email")));--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_idp_subject_unique" ON "accounts" USING btree ("idp_subject");--> statement-breakpoint
CREATE UNIQUE INDEX "guardian_invitations_token_unique" ON "guardian_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "guardian_invitations_ward_idx" ON "guardian_invitations" USING btree ("ward_person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "guardianships_open_unique" ON "guardianships" USING btree ("guardian_person_id","ward_person_id") WHERE "guardianships"."valid_to" IS NULL;--> statement-breakpoint
CREATE INDEX "guardianships_guardian_idx" ON "guardianships" USING btree ("guardian_person_id") WHERE "guardianships"."valid_to" IS NULL;--> statement-breakpoint
CREATE INDEX "guardianships_ward_idx" ON "guardianships" USING btree ("ward_person_id") WHERE "guardianships"."valid_to" IS NULL;--> statement-breakpoint
CREATE INDEX "people_pin_hash_idx" ON "people" USING btree ("personal_identity_number_hash") WHERE "people"."personal_identity_number_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "people_duplicate_idx" ON "people" USING btree ("birth_date",lower("family_name"));--> statement-breakpoint
CREATE INDEX "people_created_by_idx" ON "people" USING btree ("created_by_person_id");--> statement-breakpoint
CREATE INDEX "people_merges_kept_idx" ON "people_merges" USING btree ("kept_person_id");--> statement-breakpoint
CREATE INDEX "people_merges_merged_idx" ON "people_merges" USING btree ("merged_person_id");--> statement-breakpoint
-------------------------------------------------------------------------------
-- Hand-written part: everything drizzle-kit does not generate. Statements
-- below run in the same transaction as the tables above.
-------------------------------------------------------------------------------

-- Record history: support columns whose changes alone are not history
-- (clubs.next_member_number), and record clubs under their own club_id.
-- Replaces the functions from 0000 (same behaviour otherwise).
DROP FUNCTION history.enable_history(regclass, text[], boolean);

CREATE FUNCTION history.enable_history(
  target regclass,
  redact text[] DEFAULT '{}',
  skip_insert boolean DEFAULT false,
  ignore text[] DEFAULT '{}'
) RETURNS void
  LANGUAGE plpgsql
  AS $$
DECLARE
  missing text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = target AND attname = 'id' AND atttypid = 'uuid'::regtype AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'record history needs a uuid "id" column on %', target;
  END IF;
  SELECT string_agg(r, ', ') INTO missing FROM unnest(redact || ignore) AS r
    WHERE NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = target AND attname = r AND NOT attisdropped);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'redacted or ignored columns do not exist on %: %', target, missing;
  END IF;

  EXECUTE format('DROP TRIGGER IF EXISTS record_history_insert ON %s', target);
  EXECUTE format('DROP TRIGGER IF EXISTS record_history_update ON %s', target);
  EXECUTE format('DROP TRIGGER IF EXISTS record_history_delete ON %s', target);
  IF NOT skip_insert THEN
    EXECUTE format(
      'CREATE TRIGGER record_history_insert AFTER INSERT ON %s REFERENCING NEW TABLE AS new_rows '
      'FOR EACH STATEMENT EXECUTE FUNCTION history.capture(%L, %L)',
      target, redact::text, ignore::text
    );
  END IF;
  EXECUTE format(
    'CREATE TRIGGER record_history_update AFTER UPDATE ON %s REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows '
    'FOR EACH STATEMENT EXECUTE FUNCTION history.capture(%L, %L)',
    target, redact::text, ignore::text
  );
  EXECUTE format(
    'CREATE TRIGGER record_history_delete AFTER DELETE ON %s REFERENCING OLD TABLE AS old_rows '
    'FOR EACH STATEMENT EXECUTE FUNCTION history.capture(%L, %L)',
    target, redact::text, ignore::text
  );
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION history.capture() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  SET enable_nestloop = off
  AS $$
DECLARE
  -- v_ prefix: never collide with columns of the audited table.
  v_redacted text[] := CASE WHEN TG_NARGS > 0 THEN TG_ARGV[0]::text[] ELSE '{}'::text[] END;
  -- Ignored columns: an UPDATE changing only these (and updated_at) writes no history row.
  v_ignored text[] := CASE WHEN TG_NARGS > 1 THEN TG_ARGV[1]::text[] ELSE '{}'::text[] END;
  v_marker CONSTANT jsonb := to_jsonb('[changed]'::text);
  v_actor_kind text := coalesce(nullif(current_setting('app.actor_kind', true), ''), 'db_role');
  v_table text := TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  -- The clubs table is keyed by id; its history belongs to that club.
  v_club_is_id boolean := TG_TABLE_SCHEMA = 'public' AND TG_TABLE_NAME = 'clubs';
  v_person uuid := nullif(current_setting('app.person_id', true), '')::uuid;
  v_on_behalf_of uuid := nullif(current_setting('app.on_behalf_of', true), '')::uuid;
  v_request text := nullif(current_setting('app.request_id', true), '');
  v_transaction bigint := pg_current_xact_id()::text::bigint;
BEGIN
  IF session_user = 'clubadmin_operator' AND v_actor_kind IS DISTINCT FROM 'operator' THEN
    RAISE EXCEPTION 'clubadmin_operator must set app.actor_kind = ''operator'' and app.person_id before changing data';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    INSERT INTO history.record_changes (
      table_name, record_id, club_id, operation, changed_columns, old_values, new_values,
      actor_person_id, on_behalf_of_person_id, actor_kind, request_id, transaction_id, db_role
    )
    SELECT v_table, nr.id,
           CASE WHEN v_club_is_id THEN nr.id ELSE (n.j ->> 'club_id')::uuid END,
           'UPDATE', d.cols, d.old_vals, d.new_vals,
           v_person, v_on_behalf_of, v_actor_kind, v_request, v_transaction, session_user
    FROM new_rows AS nr
    JOIN old_rows AS orw ON orw.id = nr.id
    CROSS JOIN LATERAL (SELECT to_jsonb(nr) AS j) AS n
    CROSS JOIN LATERAL (SELECT to_jsonb(orw) AS j) AS o
    CROSS JOIN LATERAL (
      SELECT
        array_agg(e.key ORDER BY e.key) AS cols,
        jsonb_object_agg(e.key, CASE WHEN e.key = ANY (v_redacted) THEN v_marker ELSE o.j -> e.key END) AS old_vals,
        jsonb_object_agg(e.key, CASE WHEN e.key = ANY (v_redacted) THEN v_marker ELSE e.value END) AS new_vals
      FROM jsonb_each(n.j) AS e
      WHERE e.key <> 'updated_at' AND NOT e.key = ANY (v_ignored)
        AND e.value IS DISTINCT FROM o.j -> e.key
    ) AS d
    WHERE d.cols IS NOT NULL;
  ELSIF TG_OP = 'INSERT' THEN
    INSERT INTO history.record_changes (
      table_name, record_id, club_id, operation, changed_columns, old_values, new_values,
      actor_person_id, on_behalf_of_person_id, actor_kind, request_id, transaction_id, db_role
    )
    SELECT v_table, (n.j ->> 'id')::uuid,
           (CASE WHEN v_club_is_id THEN n.j ->> 'id' ELSE n.j ->> 'club_id' END)::uuid,
           'INSERT', d.cols, NULL, d.vals,
           v_person, v_on_behalf_of, v_actor_kind, v_request, v_transaction, session_user
    FROM (SELECT to_jsonb(r) AS j FROM new_rows AS r) AS n
    CROSS JOIN LATERAL (
      SELECT
        array_agg(e.key ORDER BY e.key) AS cols,
        jsonb_object_agg(e.key, CASE WHEN e.key = ANY (v_redacted) THEN v_marker ELSE e.value END) AS vals
      FROM jsonb_each(n.j) AS e
    ) AS d;
  ELSE
    INSERT INTO history.record_changes (
      table_name, record_id, club_id, operation, changed_columns, old_values, new_values,
      actor_person_id, on_behalf_of_person_id, actor_kind, request_id, transaction_id, db_role
    )
    SELECT v_table, (o.j ->> 'id')::uuid,
           (CASE WHEN v_club_is_id THEN o.j ->> 'id' ELSE o.j ->> 'club_id' END)::uuid,
           'DELETE', d.cols, d.vals, NULL,
           v_person, v_on_behalf_of, v_actor_kind, v_request, v_transaction, session_user
    FROM (SELECT to_jsonb(r) AS j FROM old_rows AS r) AS o
    CROSS JOIN LATERAL (
      SELECT
        array_agg(e.key ORDER BY e.key) AS cols,
        jsonb_object_agg(e.key, CASE WHEN e.key = ANY (v_redacted) THEN v_marker ELSE e.value END) AS vals
      FROM jsonb_each(o.j) AS e
    ) AS d;
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint

-- Field encryption data keys (envelope encryption, docs/security.md). Wrapped
-- by a master key that is never in the database. club_id NULL: the global key
-- for global tables (people.personal_identity_number).
CREATE SCHEMA crypto;
GRANT USAGE ON SCHEMA crypto TO clubadmin_app, clubadmin_operator;
CREATE TABLE crypto.data_keys (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  club_id uuid REFERENCES public.clubs (id),
  wrapped_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  rewrapped_at timestamptz,
  retired_at timestamptz
);
CREATE UNIQUE INDEX data_keys_active_unique ON crypto.data_keys
  ((coalesce(club_id, '00000000-0000-0000-0000-000000000000'::uuid))) WHERE retired_at IS NULL;
ALTER TABLE crypto.data_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE crypto.data_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY key_access ON crypto.data_keys
  USING (club_id IS NULL OR club_id = app.current_club_id())
  WITH CHECK (club_id IS NULL OR club_id = app.current_club_id());
GRANT SELECT, INSERT ON crypto.data_keys TO clubadmin_app, clubadmin_operator;
GRANT UPDATE (wrapped_key, rewrapped_at, retired_at) ON crypto.data_keys TO clubadmin_app;
--> statement-breakpoint

-- Access helpers for row-level security on the global tables. SECURITY
-- DEFINER (owner) so they can read guardianships without recursing into its
-- policies: the global tables have RLS enabled but not forced, so the owner
-- reads them directly. Club tables stay forced; inside these functions they
-- are still limited to the transaction's club.
CREATE FUNCTION app.is_system() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT coalesce(app.current_actor_kind() IN ('system_job', 'migration'), false) $$;
--> statement-breakpoint
CREATE FUNCTION app.is_guardian_of(p_ward uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.guardianships g
    WHERE g.guardian_person_id = app.current_person_id() AND g.ward_person_id = p_ward
      AND g.status = 'active' AND g.valid_to IS NULL
  )
$$;
--> statement-breakpoint
-- A parent or legal guardian (full guardian) of the ward, as opposed to a relative.
CREATE FUNCTION app.is_full_guardian_of(p_ward uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.guardianships g
    WHERE g.guardian_person_id = app.current_person_id() AND g.ward_person_id = p_ward
      AND g.kind IN ('parent', 'legal_guardian') AND g.status = 'active' AND g.valid_to IS NULL
  )
$$;
--> statement-breakpoint
CREATE FUNCTION app.is_self_or_ward(p_person uuid) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT p_person = app.current_person_id() OR app.is_guardian_of(p_person) $$;
--> statement-breakpoint
-- Who may see a person row: the person, whoever created it, their guardians,
-- wards and co-guardians, and the current club for its members and their
-- guardians. Authorization (P0.7) narrows this further; this is the backstop.
CREATE FUNCTION app.can_see_person(p_person uuid, p_created_by uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT app.is_system()
    OR p_person = app.current_person_id()
    OR p_created_by = app.current_person_id()
    OR EXISTS (
      SELECT 1 FROM public.guardianships g
      WHERE g.status = 'active' AND g.valid_to IS NULL AND (
        (g.guardian_person_id = app.current_person_id() AND g.ward_person_id = p_person)
        OR (g.ward_person_id = app.current_person_id() AND g.guardian_person_id = p_person)
      )
    )
    OR EXISTS (
      SELECT 1 FROM public.guardianships mine
      JOIN public.guardianships other ON other.ward_person_id = mine.ward_person_id
      WHERE mine.guardian_person_id = app.current_person_id() AND other.guardian_person_id = p_person
        AND mine.status = 'active' AND mine.valid_to IS NULL
        AND other.status = 'active' AND other.valid_to IS NULL
    )
    OR (app.current_club_id() IS NOT NULL AND (
      EXISTS (
        SELECT 1 FROM public.club_profiles cp
        WHERE cp.club_id = app.current_club_id() AND cp.person_id = p_person
      )
      OR EXISTS (
        SELECT 1 FROM public.guardianships g
        JOIN public.club_profiles cp ON cp.person_id = g.ward_person_id AND cp.club_id = app.current_club_id()
        WHERE g.guardian_person_id = p_person AND g.status = 'active' AND g.valid_to IS NULL
      )
      OR EXISTS (
        SELECT 1 FROM public.join_requests jr
        WHERE jr.club_id = app.current_club_id() AND p_person IN (jr.person_id, jr.requested_by_person_id)
      )
    ))
$$;
--> statement-breakpoint
-- Ward reachable from the current club (a member of it), for guardianship rows.
CREATE FUNCTION app.is_current_club_member(p_person uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT app.current_club_id() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.club_profiles cp
    WHERE cp.club_id = app.current_club_id() AND cp.person_id = p_person
  )
$$;
--> statement-breakpoint

-- The acting person is an active club manager of the current club.
CREATE FUNCTION app.is_club_manager() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
  SELECT app.current_person_id() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.club_role_assignments r
    WHERE r.club_id = app.current_club_id() AND r.person_id = app.current_person_id()
      AND r.role = 'club_manager' AND r.valid_to IS NULL
  )
$$;
--> statement-breakpoint

-- Whether a reachable person has a login (accounts are otherwise visible only
-- to their own person), e.g. to refuse merging a person who logs in.
CREATE FUNCTION app.person_has_account(p_person uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT app.can_see_person(p_person, NULL)
    AND EXISTS (SELECT 1 FROM public.accounts a WHERE a.person_id = p_person)
$$;
--> statement-breakpoint

-- Global tables: RLS enabled (not forced, see above).
ALTER TABLE public.people ENABLE ROW LEVEL SECURITY;
CREATE POLICY person_read ON public.people FOR SELECT
  USING (app.can_see_person(id, created_by_person_id));
CREATE POLICY person_insert ON public.people FOR INSERT
  WITH CHECK (app.is_system() OR id = app.current_person_id() OR created_by_person_id = app.current_person_id());
CREATE POLICY person_update ON public.people FOR UPDATE
  USING (app.can_see_person(id, created_by_person_id))
  WITH CHECK (app.can_see_person(id, created_by_person_id));
CREATE POLICY retention_access ON public.people TO clubadmin_retention USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_account ON public.accounts
  USING (app.is_system() OR person_id = app.current_person_id())
  WITH CHECK (app.is_system() OR person_id = app.current_person_id());
CREATE POLICY retention_access ON public.accounts TO clubadmin_retention USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE public.guardianships ENABLE ROW LEVEL SECURITY;
CREATE POLICY guardianship_access ON public.guardianships
  USING (
    app.is_system() OR guardian_person_id = app.current_person_id() OR ward_person_id = app.current_person_id()
    OR app.is_guardian_of(ward_person_id) OR app.is_current_club_member(ward_person_id)
  )
  WITH CHECK (
    app.is_system() OR guardian_person_id = app.current_person_id()
    OR app.is_guardian_of(ward_person_id) OR app.is_current_club_member(ward_person_id)
  );
CREATE POLICY retention_access ON public.guardianships TO clubadmin_retention USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE public.guardian_invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY invitation_access ON public.guardian_invitations
  USING (app.is_system() OR invited_by_person_id = app.current_person_id() OR app.is_guardian_of(ward_person_id))
  WITH CHECK (app.is_system() OR invited_by_person_id = app.current_person_id() OR app.is_guardian_of(ward_person_id));
CREATE POLICY retention_access ON public.guardian_invitations TO clubadmin_retention USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE public.people_merges ENABLE ROW LEVEL SECURITY;
CREATE POLICY merge_access ON public.people_merges
  USING (app.is_system() OR merged_by_person_id = app.current_person_id() OR app.can_see_person(kept_person_id, NULL))
  WITH CHECK (app.is_system() OR merged_by_person_id = app.current_person_id() OR app.can_see_person(kept_person_id, NULL));
CREATE POLICY retention_access ON public.people_merges TO clubadmin_retention USING (true) WITH CHECK (true);
--> statement-breakpoint

-- Club-owned tables: tenant isolation, updated_at, history.
SELECT app.enable_tenant_rls(t), app.enable_updated_at(t), history.enable_history(t)
FROM unnest(ARRAY[
  'public.club_memberships', 'public.club_role_assignments', 'public.club_manager_handovers',
  'public.employments', 'public.consents', 'public.groups', 'public.seasons', 'public.group_seasons',
  'public.group_memberships', 'public.group_owners', 'public.group_waitlist_entries',
  'public.join_requests'
]::regclass[]) AS t;
SELECT app.enable_tenant_rls('public.club_profiles'), app.enable_updated_at('public.club_profiles'),
  history.enable_history('public.club_profiles', redact => ARRAY['notes']);
SELECT app.enable_tenant_rls('public.invitations'), app.enable_updated_at('public.invitations'),
  history.enable_history('public.invitations', redact => ARRAY['token_hash']);
--> statement-breakpoint
-- Global tables: updated_at and history (club_id NULL in history; read through
-- dedicated access paths, P0.7).
SELECT app.enable_updated_at(t), history.enable_history(t)
FROM unnest(ARRAY['public.accounts', 'public.guardianships', 'public.people_merges']::regclass[]) AS t;
SELECT app.enable_updated_at('public.people'),
  history.enable_history('public.people', redact => ARRAY['personal_identity_number', 'personal_identity_number_hash']);
SELECT app.enable_updated_at('public.guardian_invitations'),
  history.enable_history('public.guardian_invitations', redact => ARRAY['token_hash']);
--> statement-breakpoint

-- Clubs are isolated on their id. Members (and guardians of members) can also
-- read the clubs they belong to ("my clubs").
ALTER TABLE public.clubs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clubs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.clubs
  USING (id = app.current_club_id()) WITH CHECK (id = app.current_club_id());
CREATE POLICY member_read ON public.clubs FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.club_memberships m
    WHERE m.club_id = clubs.id AND m.valid_to IS NULL AND app.is_self_or_ward(m.person_id)
  ));
CREATE POLICY retention_access ON public.clubs TO clubadmin_retention USING (true) WITH CHECK (true);
SELECT app.enable_updated_at('public.clubs'),
  history.enable_history('public.clubs', ignore => ARRAY['next_member_number']);
--> statement-breakpoint

-- A person's own relationships (and their wards') are readable in every club,
-- for "my clubs and groups". Writes stay limited to the transaction's club.
CREATE POLICY own_relationships ON public.club_memberships FOR SELECT USING (app.is_self_or_ward(person_id));
CREATE POLICY own_relationships ON public.club_profiles FOR SELECT USING (app.is_self_or_ward(person_id));
CREATE POLICY own_relationships ON public.club_role_assignments FOR SELECT USING (app.is_self_or_ward(person_id));
CREATE POLICY own_relationships ON public.group_memberships FOR SELECT USING (app.is_self_or_ward(person_id));
CREATE POLICY own_relationships ON public.group_owners FOR SELECT USING (person_id = app.current_person_id());
CREATE POLICY own_relationships ON public.employments FOR SELECT USING (person_id = app.current_person_id());
CREATE POLICY own_relationships ON public.consents FOR SELECT USING (app.is_self_or_ward(person_id));
CREATE POLICY own_relationships ON public.group_waitlist_entries FOR SELECT
  USING (app.is_self_or_ward(person_id) OR requested_by_person_id = app.current_person_id());
CREATE POLICY own_relationships ON public.join_requests FOR SELECT
  USING (app.is_self_or_ward(person_id) OR requested_by_person_id = app.current_person_id());
CREATE POLICY own_relationships ON public.club_manager_handovers FOR SELECT
  USING (to_person_id = app.current_person_id() OR from_person_id = app.current_person_id());
CREATE POLICY member_read ON public.groups FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.group_memberships gm
    WHERE gm.group_id = groups.id AND gm.valid_to IS NULL AND app.is_self_or_ward(gm.person_id)
  ) OR EXISTS (
    SELECT 1 FROM public.group_owners o
    WHERE o.group_id = groups.id AND o.valid_to IS NULL AND o.person_id = app.current_person_id()
  ));
--> statement-breakpoint

-- Relationships end (valid_to); they are never deleted by the application.
REVOKE DELETE ON public.people, public.accounts, public.clubs, public.club_profiles,
  public.club_memberships, public.club_role_assignments, public.club_manager_handovers,
  public.guardianships, public.groups, public.group_memberships, public.group_owners,
  public.people_merges
  FROM clubadmin_app, clubadmin_operator;
--> statement-breakpoint

-- Member numbers: taken from clubs.next_member_number under the club row's
-- lock, so concurrent inserts never share a number.
CREATE FUNCTION app.assign_member_number() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.member_number IS NULL THEN
    UPDATE public.clubs SET next_member_number = next_member_number + 1
      WHERE id = NEW.club_id
      RETURNING next_member_number - 1 INTO NEW.member_number;
    IF NEW.member_number IS NULL THEN
      RAISE EXCEPTION 'club % not found in the current context', NEW.club_id USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER assign_member_number BEFORE INSERT ON public.club_profiles
  FOR EACH ROW EXECUTE FUNCTION app.assign_member_number();
--> statement-breakpoint

-- Invariant (ADR 0018): every club has at least one active club manager.
-- Checked at commit (deferred), after locking the club row, so concurrent
-- transactions that each end a different manager cannot both succeed.
CREATE FUNCTION app.check_club_has_manager() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  v_club uuid;
BEGIN
  -- Separate branches: OLD has no club_id on clubs, and NEW is unset on DELETE.
  IF TG_TABLE_NAME = 'clubs' THEN
    v_club := NEW.id;
  ELSE
    v_club := OLD.club_id;
  END IF;
  PERFORM 1 FROM public.clubs WHERE id = v_club FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.club_role_assignments
    WHERE club_id = v_club AND role = 'club_manager' AND valid_to IS NULL
  ) THEN
    RAISE EXCEPTION 'a club must have at least one active club manager'
      USING ERRCODE = '23514', CONSTRAINT = 'club_has_manager';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER club_has_manager_on_create AFTER INSERT ON public.clubs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_club_has_manager();
CREATE CONSTRAINT TRIGGER club_has_manager_on_update AFTER UPDATE ON public.club_role_assignments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.role = 'club_manager' AND OLD.valid_to IS NULL)
  EXECUTE FUNCTION app.check_club_has_manager();
CREATE CONSTRAINT TRIGGER club_has_manager_on_delete AFTER DELETE ON public.club_role_assignments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.role = 'club_manager' AND OLD.valid_to IS NULL)
  EXECUTE FUNCTION app.check_club_has_manager();
--> statement-breakpoint

-- Group hierarchy: no cycles. The composite foreign key already keeps the
-- parent in the same club. A per-club advisory lock serialises hierarchy
-- changes, so two concurrent moves cannot form a cycle together.
CREATE FUNCTION app.check_group_cycle() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.parent_group_id IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('clubadmin:groups:' || NEW.club_id::text, 0));
  IF EXISTS (
    WITH RECURSIVE ancestors AS (
      SELECT g.id, g.parent_group_id FROM public.groups g WHERE g.id = NEW.parent_group_id
      UNION
      SELECT g.id, g.parent_group_id FROM public.groups g JOIN ancestors a ON g.id = a.parent_group_id
    )
    SELECT 1 FROM ancestors WHERE id = NEW.id
  ) THEN
    RAISE EXCEPTION 'group hierarchy cycle' USING ERRCODE = '23514', CONSTRAINT = 'groups_no_cycle';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER check_group_cycle BEFORE INSERT OR UPDATE OF parent_group_id ON public.groups
  FOR EACH ROW EXECUTE FUNCTION app.check_group_cycle();
--> statement-breakpoint

-- Accepting a co-guardian invitation: the invitee is not yet related to the
-- ward, so they cannot read the invitation; the secret token is the proof.
-- Returns the new guardianship ID, or NULL if the token is invalid, expired,
-- already used or the invitee is the ward.
CREATE FUNCTION app.accept_guardian_invitation(p_token_hash text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_me uuid := app.current_person_id();
  v_invitation public.guardian_invitations;
  v_guardianship uuid;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'accepting an invitation requires a person' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_invitation FROM public.guardian_invitations
    WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR v_invitation.accepted_at IS NOT NULL OR v_invitation.revoked_at IS NOT NULL
     OR v_invitation.expires_at <= now() OR v_invitation.ward_person_id = v_me THEN
    RETURN NULL;
  END IF;
  SELECT id INTO v_guardianship FROM public.guardianships
    WHERE guardian_person_id = v_me AND ward_person_id = v_invitation.ward_person_id AND valid_to IS NULL;
  IF v_guardianship IS NULL THEN
    INSERT INTO public.guardianships (guardian_person_id, ward_person_id, kind, rights, status, created_by_person_id)
    VALUES (v_me, v_invitation.ward_person_id, v_invitation.kind, v_invitation.rights, 'active', v_invitation.invited_by_person_id)
    RETURNING id INTO v_guardianship;
  END IF;
  UPDATE public.guardian_invitations
    SET accepted_at = now(), accepted_by_person_id = v_me, guardianship_id = v_guardianship
    WHERE id = v_invitation.id;
  RETURN v_guardianship;
END
$$;
REVOKE EXECUTE ON FUNCTION app.accept_guardian_invitation(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.accept_guardian_invitation(text) TO clubadmin_app;
