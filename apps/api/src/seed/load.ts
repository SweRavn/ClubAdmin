// SPDX-License-Identifier: AGPL-3.0-only
// The `load` scenario: volume for the performance tests (docs/performance.md).
// The documented exception to "write through the services" (P0.8): one
// set-based transaction as superuser, recorded in history as a system job.
// Per club: 200 people (120 children with a parent each, 40 adult members,
// 40 parents who are not members), 8 teams with two leaders each, and a
// club manager. Default size 1,000 clubs, about 200,000 people.

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
    INSERT INTO group_memberships (club_id, group_id, person_id, function)
      SELECT p.club_id, g.id, p.id, 'member'
      FROM lp AS p JOIN lg AS g ON g.club_id = p.club_id AND g.g = 1 + (p.n - 1) % 8
      WHERE p.child;
    INSERT INTO group_memberships (club_id, group_id, person_id, function)
      SELECT p.club_id, g.id, p.id, CASE WHEN p.n <= 128 THEN 'head_coach' ELSE 'assistant_coach' END
      FROM lp AS p JOIN lg AS g ON g.club_id = p.club_id AND g.g = 1 + (p.n - 121) % 8
      WHERE p.n BETWEEN 121 AND 136;
    COMMIT;
    ANALYZE;
  `);
}
