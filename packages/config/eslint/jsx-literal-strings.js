// SPDX-License-Identifier: AGPL-3.0-only

/** Attributes whose text users see or hear. */
const VISIBLE_ATTRIBUTES = new Set([
  "alt",
  "title",
  "label",
  "placeholder",
  "aria-label",
  "aria-description",
  "aria-roledescription",
  "aria-valuetext",
]);
const HAS_LETTER = /\p{L}/u;

/**
 * No user-facing string literals in JSX (CLAUDE.md rule 9): text goes through
 * message keys (next-intl). Punctuation and symbols between elements
 * ("·", "—", "(") are allowed; anything with a letter is reported, as JSX
 * text, as a string in a child expression or as a visible attribute.
 *
 * @type {import("eslint").Rule.RuleModule}
 */
export const noJsxLiteralStrings = {
  meta: {
    type: "problem",
    docs: { description: "Forbid user-facing string literals in JSX (use message keys)" },
    schema: [],
    messages: {
      text: "User-facing text in JSX: use a message key (packages/i18n/messages) instead of '{{text}}'.",
    },
  },
  create(context) {
    const report = (node, text) =>
      context.report({ node, messageId: "text", data: { text: text.trim().slice(0, 40) } });
    const isChild = (node) =>
      node.parent?.type === "JSXExpressionContainer" &&
      (node.parent.parent?.type === "JSXElement" || node.parent.parent?.type === "JSXFragment");
    return {
      JSXText(node) {
        if (HAS_LETTER.test(node.value)) report(node, node.value);
      },
      Literal(node) {
        if (typeof node.value === "string" && isChild(node) && HAS_LETTER.test(node.value)) {
          report(node, node.value);
        }
      },
      TemplateLiteral(node) {
        if (isChild(node) && node.quasis.some((q) => HAS_LETTER.test(q.value.cooked ?? ""))) {
          report(node, node.quasis.map((q) => q.value.cooked).join("…"));
        }
      },
      JSXAttribute(node) {
        const name = node.name.type === "JSXIdentifier" ? node.name.name : null;
        if (!name || !VISIBLE_ATTRIBUTES.has(name)) return;
        const value =
          node.value?.type === "JSXExpressionContainer" ? node.value.expression : node.value;
        if (
          value?.type === "Literal" &&
          typeof value.value === "string" &&
          HAS_LETTER.test(value.value)
        ) {
          report(node, value.value);
        }
      },
    };
  },
};
