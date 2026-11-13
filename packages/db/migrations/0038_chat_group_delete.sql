-- P2.1: a group that was never used can still be deleted (P1.6b) after its
-- page was opened, which creates its default channel on first use. Before a
-- group is deleted, its default channel goes with it if nobody ever wrote
-- in it (only system messages). A channel with messages keeps the group: the
-- delete then fails as before (group_in_use) and the group is archived.

CREATE FUNCTION app.chat_drop_unused_group_channel()
  RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  DELETE FROM public.chats c
  WHERE c.default_for_group_id = OLD.id
    AND NOT EXISTS (
      SELECT 1 FROM public.chat_messages m WHERE m.chat_id = c.id AND m.kind = 'text');
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION app.chat_drop_unused_group_channel() FROM PUBLIC;

CREATE TRIGGER groups_drop_unused_chat_channel
  BEFORE DELETE ON public.groups
  FOR EACH ROW EXECUTE FUNCTION app.chat_drop_unused_group_channel();
