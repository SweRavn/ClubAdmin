// SPDX-License-Identifier: AGPL-3.0-only

const NAME_FIELDS = new Set(["givenName", "familyName", "given_name", "family_name"]);
const NAME_COLUMN = /\b(given_name|family_name)\b/;

/**
 * Person names leave the API only through the PersonPresenter (CLAUDE.md
 * rule 4, ADR 0022). Outside the allowed files (presenters, the people module
 * that owns the columns), this forbids reading name fields, building objects
 * with them and SQL that selects the name columns.
 *
 * @type {import("eslint").Rule.RuleModule}
 */
export const personNamesInPresenters = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid person name fields outside presenters (PersonPresenter is the only way names reach output)",
    },
    schema: [
      {
        type: "object",
        properties: { fields: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
    ],
    messages: {
      field:
        "Person name field '{{name}}' outside a presenter: pass the person rows to PersonPresenter (ADR 0022); in the web app use PersonName or personLabel from @clubadmin/ui.",
      column:
        "SQL with person name column '{{name}}' outside a presenter: select IDs and let PersonPresenter resolve names (ADR 0022).",
    },
  },
  create(context) {
    // The web app also forbids displayName: names render through PersonName.
    const fields = new Set(context.options[0]?.fields ?? NAME_FIELDS);
    const keyName = (key) =>
      key.type === "Identifier" ? key.name : key.type === "Literal" ? String(key.value) : null;
    const checkText = (node, text) => {
      const match = NAME_COLUMN.exec(text);
      if (match) context.report({ node, messageId: "column", data: { name: match[1] } });
    };
    return {
      // { givenName: ... } and const { givenName } = person
      Property(node) {
        if (node.computed) return;
        const name = keyName(node.key);
        if (name && fields.has(name)) {
          context.report({ node: node.key, messageId: "field", data: { name } });
        }
      },
      // person.givenName, people.familyName (Drizzle column)
      MemberExpression(node) {
        if (node.computed || node.property.type !== "Identifier") return;
        if (fields.has(node.property.name)) {
          context.report({
            node: node.property,
            messageId: "field",
            data: { name: node.property.name },
          });
        }
      },
      Literal(node) {
        // Property keys are checked as fields above.
        if (node.parent?.type === "Property" && node.parent.key === node) return;
        if (typeof node.value === "string") checkText(node, node.value);
      },
      TemplateElement(node) {
        checkText(node, node.value.raw);
      },
    };
  },
};
