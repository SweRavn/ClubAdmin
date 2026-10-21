// SPDX-License-Identifier: AGPL-3.0-only
import { RuleTester } from "eslint";
import { describe, it } from "vitest";

import { personNamesInPresenters } from "./person-names.js";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({ languageOptions: { ecmaVersion: 2023, sourceType: "module" } });

ruleTester.run("person-names-in-presenters", personNamesInPresenters, {
  valid: [
    { code: "const ids = rows.map((r) => r.personId);" },
    { code: "export const q = sql`SELECT person_id FROM group_memberships`;" },
    { code: "const summary = await presenter.present(authz, clubId, rows);" },
    { code: "const sortName = 'sort_name';" },
  ],
  invalid: [
    {
      // The fixture from the P0.7 acceptance criteria: a controller returning names.
      code: "export function getMember(person) { return { id: person.id, givenName: person.givenName }; }",
      errors: [{ messageId: "field" }, { messageId: "field" }],
    },
    {
      code: "const { familyName } = person;",
      errors: [{ messageId: "field" }],
    },
    {
      code: "const rows = await tx.select({ name: people.givenName }).from(people);",
      errors: [{ messageId: "field" }],
    },
    {
      code: "const rows = await tx.execute(sql`SELECT p.given_name FROM people p`);",
      errors: [{ messageId: "column" }],
    },
    {
      code: "const sql = 'SELECT family_name FROM people';",
      errors: [{ messageId: "column" }],
    },
    {
      code: "const out = { 'given_name': name };",
      errors: [{ messageId: "field" }],
    },
  ],
});

ruleTester.run("person-names-in-presenters (web: displayName too)", personNamesInPresenters, {
  valid: [
    { code: "const label = personLabel(me.person);", options: [{ fields: ["displayName"] }] },
  ],
  invalid: [
    {
      code: "const label = me.person.displayName;",
      options: [{ fields: ["displayName", "givenName", "familyName"] }],
      errors: [{ messageId: "field" }],
    },
  ],
});
