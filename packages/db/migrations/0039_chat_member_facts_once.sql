-- P2.1: app.chat_member_facts read the chat and its club once per member
-- (and every club, without an index on the policy's terms), so a chat's page
-- read more as the installation grew (request budgets, ADR 0040). The adult
-- cutoff is now computed once, by primary keys.

CREATE OR REPLACE FUNCTION app.chat_member_facts(p_chat uuid)
  RETURNS TABLE (person_id uuid, child boolean, leader boolean, guardian_of uuid[])
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  -- Per member, by the person's own index entries: never a scan of a whole table.
  -- Once, by primary keys (not per member, and never reading every club).
  WITH c AS MATERIALIZED (
    SELECT (now() AT TIME ZONE 'UTC')::date - make_interval(years => app.adult_age((
      SELECT cl.country FROM public.clubs cl
      WHERE cl.id = (SELECT ch.club_id FROM public.chats ch WHERE ch.id = p_chat)))) AS cutoff),
  m AS MATERIALIZED (
    SELECT cm.person_id FROM public.chat_members cm WHERE cm.chat_id = p_chat AND cm.status <> 'left')
  SELECT m.person_id,
    coalesce((SELECT p.birth_date FROM public.people p WHERE p.id = m.person_id) > c.cutoff, false),
    EXISTS (
      SELECT 1 FROM public.group_memberships l
      WHERE l.person_id = m.person_id AND l.valid_to IS NULL AND l.leads
        AND (EXISTS (SELECT 1 FROM public.chat_groups cg
                     WHERE cg.chat_id = p_chat AND cg.group_id = l.group_id)
          OR EXISTS (SELECT 1 FROM public.group_memberships o
                     WHERE o.group_id = l.group_id AND o.valid_to IS NULL
                       AND o.person_id <> m.person_id
                       AND o.person_id IN (SELECT m2.person_id FROM m m2)))),
    coalesce((
      SELECT array_agg(g.ward_person_id ORDER BY g.ward_person_id) FROM public.guardianships g
      WHERE g.guardian_person_id = m.person_id AND g.valid_to IS NULL
        AND g.ward_person_id IN (SELECT m3.person_id FROM m m3)
        AND g.kind IN ('parent', 'legal_guardian') AND g.status = 'active'), '{}')
  FROM m CROSS JOIN c
$$;

