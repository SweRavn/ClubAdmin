// SPDX-License-Identifier: AGPL-3.0-only
// Metro in the pnpm workspace: Expo's config watches the workspace root and
// resolves the isolated node_modules layout. Workspace packages are
// TypeScript source with `.ts` import extensions, which Metro resolves as
// written.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Metro loads its config as CommonJS
const path = require("node:path");

// eslint-disable-next-line @typescript-eslint/no-require-imports -- Metro loads its config as CommonJS
const { getDefaultConfig } = require("expo/metro-config");

// The build variant as a bundle-time constant (src/config.ts). Set here,
// before Metro starts its transform workers, so they inherit it.
const variant = (process.env.EXPO_PUBLIC_APP_VARIANT ??= process.env.APP_VARIANT ?? "development");

// Development-only modules (the DEV_AUTH persona picker and development
// tokens) resolve to a stub in preview and production bundles, so their code
// is not in those apps at all; CI checks the production bundle.
const DEV_ONLY = [
  /[\\/]src[\\/]components[\\/]persona-picker\.tsx$/,
  /[\\/]src[\\/]auth[\\/]dev-login\.ts$/,
];
const stub = path.join(__dirname, "src", "dev-only-stub.ts");

const config = getDefaultConfig(__dirname);
if (variant !== "development") {
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    const resolved = context.resolveRequest(context, moduleName, platform);
    if (
      resolved.type === "sourceFile" &&
      DEV_ONLY.some((pattern) => pattern.test(resolved.filePath))
    ) {
      return { type: "sourceFile", filePath: stub };
    }
    return resolved;
  };
}

module.exports = config;
