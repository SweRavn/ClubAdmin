// SPDX-License-Identifier: AGPL-3.0-only

/** Roles and functions code may not name (P1.15): only the locked roles may be named. */
const ROLE_NAMES = new Set([
  "vice_chair",
  "treasurer",
  "secretary",
  "board_member",
  "deputy_board_member",
  "auditor",
  "nomination_committee",
  "registrar",
  "safeguarding_officer",
  "communications",
  "staff",
  "head_coach",
  "assistant_coach",
  "team_manager",
  "physio",
  "other_leader",
]);
const ROLE_METHODS = new Set([
  "hasClubRole",
  "isClubManager",
  "hasGroupFunction",
  "leadsGroup",
  "actorHasClubRole",
]);
const ROLE_LISTS = new Set(["LEADER_FUNCTIONS", "BOARD_ROLES"]);
// SQL deciding by function (`gm.function = 'member'`) or by role names.
const SQL_FUNCTION = /\bfunction\s*(?:=|<>|!=|\bIN\b)\s*\(?\s*'/i;
const SQL_ROLE_HELPER = /\bhas_club_role\s*\(/;
const quotedRole = (text) => {
  for (const match of text.matchAll(/'([a-z_]+)'/g)) {
    if (ROLE_NAMES.has(match[1])) return match[1];
  }
  return null;
};

/**
 * What someone may do is decided by permissions, never by role or function
 * names (P1.15, ADR 0046): policies and services ask `actor.holds(...)`,
 * SQL `app.holds_permission(...)` or the memberships' `participates` /
 * `leads`, the worker's recipients `clubHolders(...)`. The locked roles
 * (club_manager, chair) may still be named (ADR 0018). Clubs define their
 * own roles, so a role name in code would miss them.
 *
 * @type {import("eslint").Rule.RuleModule}
 */
export const noRoleNames = {
  meta: {
    type: "problem",
    docs: {
      description: "Forbid deciding by role or function names (ask for permissions, P1.15)",
    },
    schema: [],
    messages: {
      method:
        "'{{name}}' decides by role name: ask actor.holds(permission, club or group) instead (P1.15, ADR 0046).",
      list: "'{{name}}' lists role names: ask for a permission instead (P1.15, ADR 0046).",
      name: "Role or function name '{{name}}' in code: clubs define their roles; ask for a permission (actor.holds, app.holds_permission, clubHolders) instead (P1.15, ADR 0046).",
      sql: "SQL deciding by role or function: use app.holds_permission(...) or group_memberships.participates / leads (P1.15, ADR 0046).",
    },
  },
  create(context) {
    const checkText = (node, text) => {
      if (SQL_FUNCTION.test(text) || SQL_ROLE_HELPER.test(text)) {
        context.report({ node, messageId: "sql" });
        return;
      }
      const name = quotedRole(text);
      if (name) context.report({ node, messageId: "name", data: { name } });
    };
    return {
      MemberExpression(node) {
        if (node.computed || node.property.type !== "Identifier") return;
        if (ROLE_METHODS.has(node.property.name)) {
          context.report({
            node: node.property,
            messageId: "method",
            data: { name: node.property.name },
          });
        }
      },
      Identifier(node) {
        if (ROLE_LISTS.has(node.name)) {
          context.report({ node, messageId: "list", data: { name: node.name } });
        }
      },
      Literal(node) {
        if (typeof node.value !== "string") return;
        if (ROLE_NAMES.has(node.value)) {
          context.report({ node, messageId: "name", data: { name: node.value } });
        } else {
          checkText(node, node.value);
        }
      },
      TemplateElement(node) {
        checkText(node, node.value.raw);
      },
    };
  },
};
