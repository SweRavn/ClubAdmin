CREATE TABLE "account_invitations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"person_id" uuid NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by_person_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_invitations_email_normalised" CHECK ("account_invitations"."email" = lower(btrim("account_invitations"."email")))
);
--> statement-breakpoint
ALTER TABLE "people" ALTER COLUMN "birth_date" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "account_invitations" ADD CONSTRAINT "account_invitations_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_invitations" ADD CONSTRAINT "account_invitations_created_by_person_id_people_id_fk" FOREIGN KEY ("created_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_invitations_token_unique" ON "account_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "account_invitations_person_idx" ON "account_invitations" USING btree ("person_id");--> statement-breakpoint
-------------------------------------------------------------------------------
-- Hand-written part.
-------------------------------------------------------------------------------

-- Own-login invitations: visible to whoever created them, the person's full
-- guardians and the invited person themselves (once their account is linked).
ALTER TABLE public.account_invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY invitation_access ON public.account_invitations
  USING (
    app.is_system() OR created_by_person_id = app.current_person_id()
    OR person_id = app.current_person_id() OR app.is_full_guardian_of(person_id)
  )
  WITH CHECK (
    app.is_system() OR created_by_person_id = app.current_person_id()
    OR person_id = app.current_person_id() OR app.is_full_guardian_of(person_id)
  );
CREATE POLICY retention_access ON public.account_invitations TO clubadmin_retention USING (true) WITH CHECK (true);
SELECT app.enable_updated_at('public.account_invitations'),
  history.enable_history('public.account_invitations', redact => ARRAY['token_hash']);
--> statement-breakpoint

-- The sign-up flow holds only the token: it learns which person the invitation
-- is for (and the address it was sent to) before acting as that person.
CREATE FUNCTION app.find_account_invitation(p_token_hash text)
  RETURNS TABLE (invitation_id uuid, person_id uuid, email text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT i.id, i.person_id, i.email FROM public.account_invitations i
  WHERE i.token_hash = p_token_hash AND i.accepted_at IS NULL AND i.revoked_at IS NULL
    AND i.expires_at > now()
$$;
REVOKE EXECUTE ON FUNCTION app.find_account_invitation(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.find_account_invitation(text) TO clubadmin_app;
--> statement-breakpoint

-- Worker jobs and development tooling may list clubs (to work club by club);
-- club data itself stays behind the tenant policies.
CREATE POLICY system_read ON public.clubs FOR SELECT USING (app.is_system());
