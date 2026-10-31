// SPDX-License-Identifier: AGPL-3.0-only
// The `load` scenario: volume for the performance tests (docs/performance.md).
// The documented exception to "write through the services" (P0.8): one
// set-based transaction as superuser, recorded in history as a system job.
// Per club: 200 people (120 children with a parent each, 40 adult members,
// 40 parents who are not members), 8 teams with two leaders each, and a
// club manager, and 32 trainings per team (P1.4) with attendance for the
// six latest past ones and answers from half of the children to the next
// four (P1.5), and a cup for the first team with twelve places and the
// rest of the team waiting (P1.6), and ten notifications per child to its
// parent over the last 90 days (P1.7: the inbox; the latest unread, push and
// daily-email deliveries for the last 30 days). Default size 1,000 clubs, about 200,000 people, 256,000
// activities and 0.8 million attendance marks. Plus one
// large club (P1.2, the member register's budgets): 10,000 members in 40
// teams, half with photo consent, some paused, a few protected.

import type { SeedEnvironment } from "./environment.ts";

const GIVEN = [
  "Ebba",
  "Hugo",
  "Wilma",
  "Elias",
  "Alice",
  "William",
  "Freja",
  "Noah",
  "Saga",
  "Lucas",
  "Ella",
  "Adam",
];
const FAMILY = [
  "Andersson",
  "Karlsson",
  "Persson",
  "Eriksson",
  "Larsson",
  "Olsson",
  "Lindberg",
  "Holm",
  "Sandberg",
];

const list = (values: readonly string[]) => `ARRAY[${values.map((v) => `'${v}'`).join(", ")}]`;

export async function seedLoad(env: SeedEnvironment, clubs: number): Promise<void> {
  if (!Number.isInteger(clubs) || clubs < 1) throw new Error("--size must be a positive integer");
  await env.admin(`
    BEGIN;
    SELECT set_config('app.actor_kind', 'system_job', true), set_config('app.request_id', 'job:seed:load', true);
    CREATE TEMP TABLE lc ON COMMIT DROP AS
      SELECT i, uuidv7() AS id FROM generate_series(1, ${clubs}) AS i;
    INSERT INTO clubs (id, name, slug, country, default_locale, time_zone, currency, join_policy, next_member_number)
      SELECT id, 'Lastklubb ' || i, 'load-' || i, 'SE', 'sv-SE', 'Europe/Stockholm', 'SEK', 'approval', 201 FROM lc;
    CREATE TEMP TABLE lp ON COMMIT DROP AS
      SELECT c.id AS club_id, p.n, uuidv7() AS id, p.n <= 120 AS child
      FROM lc AS c CROSS JOIN generate_series(1, 200) AS p(n);
    INSERT INTO people (id, given_name, family_name, birth_date)
      SELECT id, (${list(GIVEN)})[1 + n % ${GIVEN.length}], (${list(FAMILY)})[1 + (n / 3) % ${FAMILY.length}],
             current_date - ((CASE WHEN child THEN 6 + n % 12 ELSE 30 + n % 30 END) * 365 + n % 300)
      FROM lp;
    INSERT INTO guardianships (guardian_person_id, ward_person_id, kind, rights)
      SELECT a.id, c.id, 'parent', ARRAY['act_on_behalf', 'receive_messages', 'view_schedule', 'sign_up', 'see_medical']
      FROM lp AS c JOIN lp AS a ON a.club_id = c.club_id AND a.n = 121 + (c.n - 1) % 80
      WHERE c.child;
    INSERT INTO club_memberships (club_id, person_id, status)
      SELECT club_id, id, 'active' FROM lp WHERE n <= 160;
    INSERT INTO club_profiles (club_id, person_id, member_number)
      SELECT club_id, id, n FROM lp WHERE n <= 160;
    INSERT INTO club_role_assignments (club_id, person_id, role)
      SELECT club_id, id, 'club_manager' FROM lp WHERE n = 121;
    CREATE TEMP TABLE lg ON COMMIT DROP AS
      SELECT c.id AS club_id, g, uuidv7() AS id FROM lc AS c CROSS JOIN generate_series(1, 8) AS g;
    INSERT INTO groups (id, club_id, name, kind, admission_mode)
      SELECT id, club_id, 'Lag ' || g, 'team', 'direct' FROM lg;
    -- In their teams since last year (so past activities have them on the roster, P1.5).
    INSERT INTO group_memberships (club_id, group_id, person_id, function, valid_from)
      SELECT p.club_id, g.id, p.id, 'member', now() - interval '1 year'
      FROM lp AS p JOIN lg AS g ON g.club_id = p.club_id AND g.g = 1 + (p.n - 1) % 8
      WHERE p.child;
    INSERT INTO group_memberships (club_id, group_id, person_id, function, valid_from)
      SELECT p.club_id, g.id, p.id, CASE WHEN p.n <= 128 THEN 'head_coach' ELSE 'assistant_coach' END,
             now() - interval '1 year'
      FROM lp AS p JOIN lg AS g ON g.club_id = p.club_id AND g.g = 1 + (p.n - 121) % 8
      WHERE p.n BETWEEN 121 AND 136;
    -- Activities (P1.4): two trainings a week per team, eight weeks back and
    -- eight ahead, with their groups and calendar entries.
    CREATE TEMP TABLE la ON COMMIT DROP AS
      SELECT uuidv7() AS id, g.club_id, g.id AS group_id,
             (date_trunc('week', now()) - interval '8 weeks' + make_interval(days => (k / 2) * 7 + (k % 2) * 2)
               + make_interval(hours => 15 + g.g % 4)) AS starts_at
      FROM lg AS g CROSS JOIN generate_series(0, 31) AS k;
    INSERT INTO activities (id, club_id, kind, title, starts_at, ends_at, created_by_person_id)
      SELECT a.id, a.club_id, 'training', 'Träning', a.starts_at, a.starts_at + interval '90 minutes', m.person_id
      FROM la AS a JOIN club_role_assignments AS m ON m.club_id = a.club_id AND m.role = 'club_manager';
    INSERT INTO activity_groups (club_id, activity_id, group_id) SELECT club_id, id, group_id FROM la;
    INSERT INTO schedule_entries (club_id, activity_id, group_id, kind, title, status, starts_at, ends_at, all_day, changed_at)
      SELECT club_id, id, group_id, 'training', 'Träning', 'scheduled', starts_at, starts_at + interval '90 minutes', false, now()
      FROM la;
    -- Responses and attendance (P1.5): marks for the six latest past sessions
    -- (members and leaders, recorded by the head coach), answers from half of
    -- the children to the next four sessions. (Every past session would take
    -- the scenario over its ten minutes: each row also writes history.)
    CREATE TEMP TABLE lr ON COMMIT DROP AS
      SELECT a.id AS activity_id, a.club_id, a.group_id, a.starts_at,
             row_number() OVER (PARTITION BY a.group_id ORDER BY a.starts_at DESC) AS k
      FROM la AS a WHERE a.starts_at < now() - interval '2 hours';
    CREATE TEMP TABLE lu ON COMMIT DROP AS
      SELECT a.id AS activity_id, a.club_id, a.group_id,
             row_number() OVER (PARTITION BY a.group_id ORDER BY a.starts_at) AS ahead
      FROM la AS a WHERE a.starts_at >= now();
    ANALYZE lr;
    ANALYZE lu;
    INSERT INTO attendance_records (club_id, activity_id, person_id, status, role, recorded_by_person_id, recorded_at)
      SELECT r.club_id, r.activity_id, gm.person_id,
             CASE WHEN gm.function <> 'member' THEN 'present'
                  WHEN (r.k + abs(hashtext(gm.person_id::text))) % 9 = 0 THEN 'absent'
                  WHEN (r.k + abs(hashtext(gm.person_id::text))) % 13 = 0 THEN 'excused'
                  ELSE 'present' END,
             CASE WHEN gm.function = 'member' THEN 'participant' ELSE 'leader' END,
             coach.person_id, r.starts_at + interval '100 minutes'
      FROM lr AS r
      JOIN group_memberships AS gm ON gm.group_id = r.group_id
      JOIN group_memberships AS coach ON coach.group_id = r.group_id AND coach.function = 'head_coach'
      WHERE r.k <= 6;
    INSERT INTO activity_responses (club_id, activity_id, person_id, status, responded_by_person_id)
      SELECT r.club_id, r.activity_id, gm.person_id,
             CASE WHEN abs(hashtext(gm.person_id::text)) % 5 = 0 THEN 'not_attending' ELSE 'attending' END,
             gm.person_id
      FROM lu AS r
      JOIN group_memberships AS gm ON gm.group_id = r.group_id AND gm.function = 'member'
      WHERE r.ahead <= 4 AND abs(hashtext(gm.person_id::text)) % 2 = 0;
    -- Events (P1.6): a cup for each club's first team in three weeks, twelve
    -- places taken, the rest of the team on the waiting list, signed up by
    -- their parents.
    CREATE TEMP TABLE le ON COMMIT DROP AS
      SELECT uuidv7() AS id, g.club_id, g.id AS group_id FROM lg AS g WHERE g.g = 1;
    INSERT INTO events (id, club_id, title, audience, status, starts_at, ends_at,
                        registration_closes_at, capacity, waitlist_mode, created_by_person_id)
      SELECT e.id, e.club_id, 'Cup', 'groups', 'published', now() + interval '21 days',
             now() + interval '21 days 6 hours', now() + interval '14 days', 12, 'offer', m.person_id
      FROM le AS e JOIN club_role_assignments AS m ON m.club_id = e.club_id AND m.role = 'club_manager';
    INSERT INTO event_groups (club_id, event_id, group_id) SELECT club_id, id, group_id FROM le;
    INSERT INTO event_registrations (club_id, event_id, person_id, registered_by_person_id, status, queued_at)
      SELECT e.club_id, e.id, gm.person_id, gu.guardian_person_id,
             CASE WHEN row_number() OVER (PARTITION BY e.id ORDER BY gm.person_id) <= 12
                  THEN 'confirmed' ELSE 'waitlisted' END,
             now() - make_interval(mins => (row_number() OVER (PARTITION BY e.id ORDER BY gm.person_id))::int)
      FROM le AS e
      JOIN group_memberships AS gm ON gm.group_id = e.group_id AND gm.function = 'member'
      JOIN guardianships AS gu ON gu.ward_person_id = gm.person_id;
    -- Notifications (P1.7): ten per child to its parent, one every nine days
    -- over the last 90 (IDs follow the time, as the worker's do); the latest
    -- unread; a push and a daily-email delivery for those of the last 30 days.
    CREATE TEMP TABLE lak ON COMMIT DROP AS
      SELECT id, group_id, (row_number() OVER (PARTITION BY group_id ORDER BY starts_at) - 1)::int AS k
      FROM la;
    ANALYZE lak;
    CREATE TEMP TABLE ln ON COMMIT DROP AS
      SELECT uuidv7(-make_interval(days => k.k * 9, mins => c.n)) AS id, gu.guardian_person_id AS recipient,
             c.club_id, c.id AS child, k.k, now() - make_interval(days => k.k * 9, mins => c.n) AS created_at,
             a.id AS activity_id
      FROM lp AS c
      JOIN guardianships AS gu ON gu.ward_person_id = c.id
      JOIN lg AS g ON g.club_id = c.club_id AND g.g = 1 + (c.n - 1) % 8
      CROSS JOIN generate_series(0, 9) AS k(k)
      JOIN lak AS a ON a.group_id = g.id AND a.k = k.k
      WHERE c.child;
    INSERT INTO notifications (id, recipient_person_id, club_id, category, type, subject_type, subject_id,
                               about_person_ids, params, dedupe_key, read_at, created_at, updated_at)
      SELECT id, recipient, club_id,
             CASE WHEN k % 3 = 0 THEN 'responses' ELSE 'schedule' END,
             CASE k % 3 WHEN 0 THEN 'response.reminder' WHEN 1 THEN 'activity.cancelled' ELSE 'activity.moved' END,
             'activity', activity_id, ARRAY[child],
             jsonb_build_object('title', 'Träning', 'startsAt', created_at + interval '2 days',
                                'timeZone', 'Europe/Stockholm', 'group', 'Lag'),
             'load:' || id, CASE WHEN k > 0 THEN created_at + interval '3 hours' END, created_at, created_at
      FROM ln;
    INSERT INTO notification_deliveries (notification_id, channel, status, digest, send_after, sent_at, created_at, updated_at)
      SELECT id, ch.channel, 'sent', ch.channel = 'email', created_at, created_at + interval '1 minute', created_at, created_at
      FROM ln CROSS JOIN (VALUES ('push'), ('email')) AS ch(channel)
      WHERE k <= 3;
    -- The large club.
    CREATE TEMP TABLE bc ON COMMIT DROP AS SELECT uuidv7() AS id;
    INSERT INTO clubs (id, name, slug, country, default_locale, time_zone, currency, join_policy, next_member_number)
      SELECT id, 'Storklubben', 'load-large', 'SE', 'sv-SE', 'Europe/Stockholm', 'SEK', 'approval', 10001 FROM bc;
    CREATE TEMP TABLE bp ON COMMIT DROP AS
      SELECT n, uuidv7() AS id FROM generate_series(1, 10000) AS n;
    INSERT INTO people (id, given_name, family_name, birth_date, gender, protected_identity)
      SELECT id, (${list(GIVEN)})[1 + n % ${GIVEN.length}], (${list(FAMILY)})[1 + (n / 7) % ${FAMILY.length}],
             current_date - ((6 + n % 60) * 365 + n % 300), (ARRAY['female', 'male'])[1 + n % 2], n % 1000 = 0
      FROM bp;
    INSERT INTO club_memberships (club_id, person_id, status, membership_type, valid_from)
      SELECT bc.id, bp.id, CASE WHEN n % 50 = 0 THEN 'paused' ELSE 'active' END,
             CASE WHEN n % 20 = 0 THEN 'supporting' ELSE 'active' END,
             now() - make_interval(days => n % 3650)
      FROM bp CROSS JOIN bc;
    INSERT INTO club_profiles (club_id, person_id, member_number, shared_fields)
      SELECT bc.id, bp.id, n, CASE WHEN n % 3 = 0 THEN ARRAY['phone', 'gender'] ELSE '{}'::text[] END
      FROM bp CROSS JOIN bc;
    INSERT INTO club_role_assignments (club_id, person_id, role)
      SELECT bc.id, bp.id, r.role FROM bp CROSS JOIN bc
      CROSS JOIN (VALUES ('club_manager'), ('registrar')) AS r(role) WHERE bp.n = 1;
    CREATE TEMP TABLE bg ON COMMIT DROP AS SELECT g, uuidv7() AS id FROM generate_series(1, 40) AS g;
    INSERT INTO groups (id, club_id, name, kind, admission_mode)
      SELECT bg.id, bc.id, 'Lag ' || g, 'team', 'direct' FROM bg CROSS JOIN bc;
    INSERT INTO group_memberships (club_id, group_id, person_id, function)
      SELECT bc.id, bg.id, bp.id, 'member' FROM bp CROSS JOIN bc JOIN bg ON bg.g = 1 + bp.n % 40;
    INSERT INTO consents (club_id, person_id, purpose, text_version, given_by_person_id)
      SELECT bc.id, bp.id, 'photo_publication', 'v1', bp.id FROM bp CROSS JOIN bc WHERE n % 2 = 0;
    COMMIT;
    ANALYZE;
  `);
}
