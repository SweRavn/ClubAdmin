// SPDX-License-Identifier: AGPL-3.0-only
import { RuleTester } from "eslint";
import { describe, it } from "vitest";

import { noRoleNames } from "./role-names.js";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({ languageOptions: { ecmaVersion: 2023, sourceType: "module" } });

ruleTester.run("no-role-names", noRoleNames, {
  valid: [
    { code: 'const ok = actor.holds("club.members.import", clubId);' },
    { code: "const q = sql`SELECT person_id FROM group_memberships WHERE participates`;" },
    { code: "const q = sql`SELECT app.holds_permission(${club}, 'club.guardians.manage')`;" },
    // The locked roles may be named (ADR 0018).
    { code: "const q = sql`SELECT 1 FROM club_role_assignments WHERE role = 'club_manager'`;" },
    { code: 'await roles.assignRoleInTx(tx, context, personId, "club_manager");' },
    { code: "const fn = row.function;" },
  ],
  invalid: [
    { code: 'if (actor.hasClubRole(clubId, "chair")) {}', errors: [{ messageId: "method" }] },
    { code: "if (actor.isClubManager(clubId)) {}", errors: [{ messageId: "method" }] },
    { code: "const leaders = LEADER_FUNCTIONS;", errors: [{ messageId: "list" }] },
    {
      code: 'const ok = roles.includes("registrar");',
      errors: [{ messageId: "name" }],
    },
    {
      code: "const q = sql`SELECT 1 FROM group_memberships gm WHERE gm.function = 'member'`;",
      errors: [{ messageId: "sql" }],
    },
    {
      code: "const q = sql`WHERE r.role IN ('club_manager', 'treasurer')`;",
      errors: [{ messageId: "name" }],
    },
    {
      code: "const q = sql`SELECT app.has_club_role(ARRAY['club_manager'])`;",
      errors: [{ messageId: "sql" }],
    },
  ],
});
