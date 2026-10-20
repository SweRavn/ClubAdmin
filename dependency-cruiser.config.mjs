// SPDX-License-Identifier: AGPL-3.0-only
// Module boundaries (docs/architecture.md, CLAUDE.md). Checked by `pnpm lint`.

/** @type {import("dependency-cruiser").IConfiguration} */
export default {
  forbidden: [
    {
      name: "module-internals",
      comment:
        "An API module may use another module only through its public index.ts (its exported service), never its internals.",
      severity: "error",
      from: { path: "^apps/api/src/modules/([^/]+)/" },
      to: {
        path: "^apps/api/src/modules/[^/]+/",
        pathNot: ["^apps/api/src/modules/$1/", "^apps/api/src/modules/[^/]+/index\\.ts$"],
      },
    },
    {
      name: "packages-import-apps",
      comment: "Shared packages must not depend on applications.",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: "^apps/" },
    },
    {
      name: "apps-import-other-apps",
      comment: "Applications are deployed separately; share code through packages/ instead.",
      severity: "error",
      from: { path: "^apps/([^/]+)/" },
      to: { path: "^apps/", pathNot: "^apps/$1/" },
    },
    {
      name: "production-imports-tests",
      comment: "Production code must not import tests or test helpers.",
      severity: "error",
      from: { pathNot: ["\\.test\\.ts$", "/testing/"] },
      to: { path: ["\\.test\\.ts$", "/src/testing/"] },
    },
    {
      name: "no-circular",
      comment:
        "Circular imports make module boundaries meaningless and break initialisation order.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)(node_modules|dist|coverage|\\.next|\\.turbo|fixtures)/" },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    enhancedResolveOptions: {
      extensions: [".ts", ".tsx", ".js", ".mjs", ".json"],
      conditionNames: ["import", "default"],
    },
  },
};
