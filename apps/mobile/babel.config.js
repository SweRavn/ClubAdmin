// SPDX-License-Identifier: AGPL-3.0-only
// Workspace packages are TypeScript source with JSON import attributes
// (`with { type: "json" }`); babel-preset-expo compiles both.
module.exports = function (api) {
  api.cache(true);
  return { presets: ["babel-preset-expo"] };
};
