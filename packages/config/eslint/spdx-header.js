// SPDX-License-Identifier: AGPL-3.0-only

export const SPDX_HEADER = "// SPDX-License-Identifier: AGPL-3.0-only";

/**
 * Requires every source file to start with the AGPL SPDX header
 * (after an optional shebang line). Autofix inserts it.
 *
 * @type {import("eslint").Rule.RuleModule}
 */
export const spdxHeader = {
  meta: {
    type: "problem",
    docs: { description: `Require "${SPDX_HEADER}" as the first line of every source file` },
    fixable: "code",
    schema: [],
    messages: { missing: `Source files must start with "${SPDX_HEADER}".` },
  },
  create(context) {
    return {
      Program(node) {
        const text = context.sourceCode.getText();
        const hasShebang = text.startsWith("#!");
        const lines = text.split(/\r?\n/);
        const headerLine = hasShebang ? lines[1] : lines[0];
        if (headerLine?.trim() === SPDX_HEADER) return;

        context.report({
          node,
          loc: { line: 1, column: 0 },
          messageId: "missing",
          fix(fixer) {
            if (hasShebang) {
              const shebangEnd = text.indexOf("\n");
              const offset = shebangEnd === -1 ? text.length : shebangEnd + 1;
              const prefix = shebangEnd === -1 ? "\n" : "";
              return fixer.insertTextAfterRange([0, offset], `${prefix}${SPDX_HEADER}\n`);
            }
            return fixer.insertTextBeforeRange([0, 0], `${SPDX_HEADER}\n`);
          },
        });
      },
    };
  },
};
