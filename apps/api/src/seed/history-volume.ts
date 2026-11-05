// SPDX-License-Identifier: AGPL-3.0-only
// History volume for the volume tests (P1.9, ADR 0042): two years of record
// history (about 5 million rows) and audit events (about 500,000) for
// Storklubben of the load scenario, written straight into history and audit
// as the superuser. Only with `pnpm db:seed --history-volume` on top of the
// load scenario (Nightly and by hand), never in the CI workflow or the
// demo: reading history must be measured on volume, but the volume must not
// slow down everything else.
//
// As in production, every month has its own partition (rows that seeding
// backdated into the default partition are moved out first, as
// history.maintain_partitions does). One member, the first of Storklubben,
// gets five years of changes on their own rows within the retention, the
// person panel's worst case.

export const HISTORY_VOLUME_ROWS = 5_000_000;
export const AUDIT_VOLUME_ROWS = 500_000;

/** The statements, in order (each its own transaction). */
export function historyVolumeSql(
  options: { rows?: number; auditRows?: number; months?: number } = {},
): string[] {
  const rows = options.rows ?? HISTORY_VOLUME_ROWS;
  const auditRows = options.auditRows ?? AUDIT_VOLUME_ROWS;
  const months = options.months ?? 24;
  return [
    // Monthly partitions for the past `months` months.
    `DO $$
    DECLARE
      m date;
      lower_bound timestamptz;
      upper_bound timestamptz;
      name text;
    BEGIN
      FOR i IN 1..${months} LOOP
        m := (date_trunc('month', now() AT TIME ZONE 'UTC') - make_interval(months => i))::date;
        name := 'record_changes_' || to_char(m, 'YYYY_MM');
        IF to_regclass('history.' || name) IS NULL THEN
          lower_bound := m::timestamp AT TIME ZONE 'UTC';
          upper_bound := (m + interval '1 month')::timestamp AT TIME ZONE 'UTC';
          CREATE TEMP TABLE moved_rows (LIKE history.record_changes) ON COMMIT DROP;
          INSERT INTO moved_rows SELECT * FROM history.record_changes_default
            WHERE changed_at >= lower_bound AND changed_at < upper_bound;
          DELETE FROM history.record_changes_default
            WHERE changed_at >= lower_bound AND changed_at < upper_bound;
          EXECUTE format('CREATE TABLE history.%I PARTITION OF history.record_changes FOR VALUES FROM (%L) TO (%L)',
            name, lower_bound, upper_bound);
          INSERT INTO history.record_changes SELECT * FROM moved_rows;
          DROP TABLE moved_rows;
        END IF;
      END LOOP;
    END $$`,
    // The club's changes: tables of the history view policy, 20,000 records,
    // the club's managers and members as actors, spread over the period.
    `INSERT INTO history.record_changes (id, changed_at, table_name, record_id, club_id, operation,
       changed_columns, old_values, new_values, actor_person_id, actor_kind, request_id, transaction_id, db_role)
     SELECT uuidv7(), now() - make_interval(secs => (g::float8 / ${rows}) * ${months} * 30 * 86400),
       t.name, r.ids[1 + g % 20000], c.id, 'UPDATE',
       ARRAY['status'], '{"status": "active"}'::jsonb, '{"status": "paused"}'::jsonb,
       a.ids[1 + g % array_length(a.ids, 1)], 'person', 'volume', 1000000 + g / 3, 'clubadmin_app'
     FROM generate_series(1, ${rows}) AS g
     CROSS JOIN (SELECT id FROM clubs WHERE slug = 'load-large') AS c
     CROSS JOIN (SELECT array_agg(uuidv7()) AS ids FROM generate_series(1, 20000)) AS r
     CROSS JOIN (SELECT array_agg(person_id) AS ids FROM (
       SELECT person_id FROM club_memberships
       WHERE club_id = (SELECT id FROM clubs WHERE slug = 'load-large') LIMIT 200) p) AS a
     CROSS JOIN LATERAL (SELECT (ARRAY['public.club_memberships', 'public.group_memberships',
       'public.activity_responses', 'public.attendance_records', 'public.club_profiles',
       'public.consents', 'public.activities', 'public.groups'])[1 + g % 8] AS name) AS t`,
    // The panel's worst case: the first member's own rows changed every few days.
    `INSERT INTO history.record_changes (id, changed_at, table_name, record_id, club_id, operation,
       changed_columns, old_values, new_values, actor_person_id, actor_kind, request_id, transaction_id, db_role)
     SELECT uuidv7(), now() - make_interval(days => g * 2), 'public.club_memberships', m.id, m.club_id,
       'UPDATE', ARRAY['membership_type'], '{"membership_type": "active"}'::jsonb,
       '{"membership_type": "supporting"}'::jsonb, m.person_id, 'person', 'volume', 2000000 + g, 'clubadmin_app'
     FROM generate_series(1, ${months * 15}) AS g
     CROSS JOIN (SELECT ms.id, ms.club_id, ms.person_id FROM club_memberships ms
       JOIN club_profiles cp ON cp.club_id = ms.club_id AND cp.person_id = ms.person_id
       WHERE ms.club_id = (SELECT id FROM clubs WHERE slug = 'load-large') AND cp.member_number = 1
       LIMIT 1) AS m`,
    // The audit log: actions of every category over the period.
    `INSERT INTO audit.events (id, created_at, club_id, actor_person_id, actor_kind, action,
       resource_type, resource_id, changed_fields, request_id)
     SELECT uuidv7(), now() - make_interval(secs => (g::float8 / ${auditRows}) * ${months} * 30 * 86400),
       c.id, a.ids[1 + g % array_length(a.ids, 1)], 'person',
       (ARRAY['membership.type.changed', 'group.membership.created', 'attendance.corrected',
         'activity.updated', 'consent.given', 'club.role.assigned', 'members.exported',
         'event.registration.created'])[1 + g % 8],
       (ARRAY['club_membership', 'group_membership', 'attendance_record', 'activity', 'consent',
         'club_role_assignment', 'member_export', 'event_registration'])[1 + g % 8],
       uuidv7(), ARRAY['status'], 'volume'
     FROM generate_series(1, ${auditRows}) AS g
     CROSS JOIN (SELECT id FROM clubs WHERE slug = 'load-large') AS c
     CROSS JOIN (SELECT array_agg(person_id) AS ids FROM (
       SELECT person_id FROM club_memberships
       WHERE club_id = (SELECT id FROM clubs WHERE slug = 'load-large') LIMIT 200) p) AS a`,
    "ANALYZE history.record_changes",
    "ANALYZE audit.events",
  ];
}
