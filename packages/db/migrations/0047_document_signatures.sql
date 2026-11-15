-- P2.4 part C (ADR 0049 decision 6): signing in the app. The signers of a
-- version are named first (the chair, the secretary, the adjusters); each
-- signs with a recent login with a second factor, which records the level
-- (`simple`), the provider (`in_app`; BankID, Freja and the EU wallet
-- later) and the SHA-256 of exactly the signed version. When everyone
-- named has signed, the worker makes the signature page (a PDF with the
-- hash and the signers) and stores it beside the version.

CREATE TABLE public.document_signatures (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  club_id uuid NOT NULL REFERENCES public.clubs(id),
  version_id uuid NOT NULL,
  signer_person_id uuid NOT NULL REFERENCES public.people(id),
  role text NOT NULL CONSTRAINT document_signatures_role
    CHECK (role IN ('chair', 'secretary', 'adjuster', 'other')),
  requested_by_person_id uuid REFERENCES public.people(id),
  -- Set when signed.
  level text CONSTRAINT document_signatures_level CHECK (level IN ('simple')),
  provider text CONSTRAINT document_signatures_provider CHECK (char_length(provider) BETWEEN 1 AND 40),
  sha256 text CONSTRAINT document_signatures_sha256 CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  signed_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT document_signatures_club_id_unique UNIQUE (club_id, id),
  CONSTRAINT document_signatures_version_fk FOREIGN KEY (club_id, version_id)
    REFERENCES public.document_versions (club_id, id),
  CONSTRAINT document_signatures_unique UNIQUE (version_id, signer_person_id),
  CONSTRAINT document_signatures_signed CHECK (
    (signed_at IS NULL) = (level IS NULL) AND (signed_at IS NULL) = (sha256 IS NULL)
    AND (signed_at IS NULL) = (provider IS NULL))
);
-- "Waiting for my signature": a person's open requests.
CREATE INDEX document_signatures_signer_idx ON public.document_signatures (signer_person_id)
  WHERE signed_at IS NULL;
CREATE INDEX document_signatures_signer_all_idx ON public.document_signatures (signer_person_id);
CREATE INDEX document_signatures_requested_by_idx ON public.document_signatures (requested_by_person_id)
  WHERE requested_by_person_id IS NOT NULL;

-- The signature page the worker made (documents/<club>/<document>/<version>-signatures.pdf).
ALTER TABLE public.document_versions ADD COLUMN signature_page_object_key text;
ALTER TABLE public.document_versions ADD COLUMN signature_page_made_at timestamptz;
--> statement-breakpoint

SELECT app.enable_tenant_rls('public.document_signatures'), app.enable_updated_at('public.document_signatures'),
  history.enable_history('public.document_signatures');
-- The worker reads a version's signatures to make its page.
CREATE POLICY system_read ON public.document_signatures FOR SELECT USING (app.is_system());
--> statement-breakpoint

-- A signed signature never changes (ADR 0049: the signature page detects
-- later change); erasure may clear the person columns only.
CREATE FUNCTION app.lock_signature() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'signature % is signed and kept', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.signed_at IS DISTINCT FROM OLD.signed_at OR NEW.sha256 IS DISTINCT FROM OLD.sha256
    OR NEW.level IS DISTINCT FROM OLD.level OR NEW.version_id IS DISTINCT FROM OLD.version_id THEN
    RAISE EXCEPTION 'signature % is signed and locked', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER document_signatures_lock BEFORE UPDATE OR DELETE ON public.document_signatures
  FOR EACH ROW WHEN (OLD.signed_at IS NOT NULL) EXECUTE FUNCTION app.lock_signature();

-- "Waiting for my signature" across the caller's clubs (each read in turn,
-- tenant RLS, as app.my_tasks): open requests on versions still in their
-- documents, newest first. At most p_limit.
CREATE FUNCTION app.my_signature_requests(p_limit integer)
  RETURNS TABLE (signature_id uuid, club_id uuid, club_name text, document_id uuid,
    document_name text, version_id uuid, version_number integer, role text, requested_at timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_me uuid := app.current_person_id();
  v_prev text := coalesce(current_setting('app.club_id', true), '');
  v_club uuid;
BEGIN
  IF v_me IS NULL THEN
    RETURN;
  END IF;
  FOREACH v_club IN ARRAY app.my_clubs_for(ARRAY[v_me]) LOOP
    PERFORM set_config('app.club_id', v_club::text, true);
    RETURN QUERY
    SELECT s.id, s.club_id, (SELECT cl.name FROM public.clubs cl WHERE cl.id = s.club_id),
      d.id, d.name, v.id, v.number, s.role, s.created_at
    FROM public.document_signatures s
    JOIN public.document_versions v ON v.id = s.version_id
    JOIN public.documents d ON d.id = v.document_id AND d.deleted_at IS NULL
    WHERE s.signer_person_id = v_me AND s.signed_at IS NULL AND s.club_id = v_club
    ORDER BY s.created_at DESC LIMIT p_limit;
  END LOOP;
  PERFORM set_config('app.club_id', v_prev, true);
END
$$;
REVOKE ALL ON FUNCTION app.my_signature_requests(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_signature_requests(integer) TO clubadmin_app;
