// SPDX-License-Identifier: AGPL-3.0-only
// The installation's plugins (ADR 0051 decision 4): checked when the API
// starts (manifest, licence, contract version, capabilities) so that an
// incompatible plugin stops the start instead of failing later.

import { type Plugin, pluginProblems, servesCountry } from "@clubadmin/plugin-api";

export const PLUGIN_REGISTRY = Symbol("PLUGIN_REGISTRY");

export class PluginRegistry {
  private readonly byId = new Map<string, Plugin>();

  constructor(plugins: readonly Plugin[]) {
    for (const plugin of plugins) {
      const problems = pluginProblems(plugin);
      if (problems.length) {
        throw new Error(`plugin ${plugin.manifest.id} cannot be installed: ${problems.join("; ")}`);
      }
      if (this.byId.has(plugin.manifest.id))
        throw new Error(`plugin ${plugin.manifest.id} is listed twice`);
      this.byId.set(plugin.manifest.id, plugin);
    }
  }

  /** The bundled plugins the configuration installs (an empty list: all of them). */
  static fromConfig(bundled: readonly Plugin[], installed: readonly string[]): PluginRegistry {
    if (installed.length === 0) return new PluginRegistry(bundled);
    const known = new Map(bundled.map((p) => [p.manifest.id, p]));
    const unknown = installed.filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`PLUGINS lists unknown plugins: ${unknown.join(", ")}`);
    return new PluginRegistry(installed.map((id) => known.get(id)!));
  }

  all(): Plugin[] {
    return [...this.byId.values()].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  }

  get(id: string): Plugin | undefined {
    return this.byId.get(id);
  }

  forCountry(country: string): Plugin[] {
    return this.all().filter((p) => servesCountry(p, country));
  }
}
