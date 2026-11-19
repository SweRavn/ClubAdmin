// SPDX-License-Identifier: AGPL-3.0-only
// Plugins in the web app (P2.7 part C).

/** A plugin's name: its first scheme's or check type's text, else its ID. */
export function pluginName(plugin: { id: string; texts?: Record<string, string> }): string {
  const entry = Object.entries(plugin.texts ?? {}).find(([key]) => /\.(scheme|name)$/.test(key));
  return entry?.[1] ?? plugin.id;
}
