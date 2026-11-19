// SPDX-License-Identifier: AGPL-3.0-only
// The host side of plugins (P2.7, ADR 0051 decisions 3 and 4): a club's
// plugins and their settings, and calls into a plugin with a context that
// holds the club, its validated configuration, decrypted secrets, a clock,
// a logger that refuses personal data, an HTTP client limited to the
// declared hosts and the plugin's state. Calls run outside any transaction
// (a plugin may wait on a remote service); a failed call is audited and
// contained.

import { audit, type Database, type TenantContext } from "@clubadmin/db";
import {
  callPlugin,
  type CheckType,
  CheckTypeSchema,
  type JsonValue,
  type Plugin,
  PLUGIN_API_VERSION,
  type PluginCallResult,
  type PluginContext,
  type PluginHttpRequest,
  type PluginHttpResponse,
  type Requirement,
  RequirementSchema,
  restrictedHttp,
  safeLogger,
  servesCountry,
  validateConfig,
} from "@clubadmin/plugin-api";
import type { Logger } from "@clubadmin/server-kit";
import {
  type BackgroundCheckTypes,
  type ClubPlugin,
  type InstalledPlugin,
  type PutClubPluginInput,
  PutClubPluginSchema,
  z,
} from "@clubadmin/shared";

import type { FieldEncryption } from "../../platform/crypto/field-encryption.ts";
import { DomainError } from "../../platform/domain/domain-error.ts";
import { parseInput } from "../../platform/domain/run.ts";
import type { ClubsService } from "../clubs/index.ts";
import type { PluginRegistry } from "./plugins.registry.ts";
import * as repo from "./plugins.repository.ts";

type Send = (url: string, init: PluginHttpRequest) => Promise<PluginHttpResponse>;

/** HTTPS requests with a timeout; the restricted client decides which hosts. */
const fetchSend: Send = async (url, init) => {
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: init.headers ?? {},
    ...(init.body === undefined ? {} : { body: init.body }),
    signal: AbortSignal.timeout(8_000),
    redirect: "error",
  });
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: await response.text(),
  };
};

const secretAad = (clubId: string, pluginId: string, name: string) =>
  `club_plugin_secrets:${clubId}:${pluginId}:${name}`;

const LOCALES = ["sv", "en", "nb"] as const;
const textsIn = (plugin: Plugin, locale: string) =>
  plugin.manifest.texts[(LOCALES as readonly string[]).includes(locale) ? (locale as "sv") : "en"];

export function installedPlugin(plugin: Plugin): InstalledPlugin {
  const m = plugin.manifest;
  return {
    id: m.id,
    version: m.version,
    publisher: m.publisher,
    licence: m.licence,
    pluginApi: m.pluginApi,
    capabilities: [...m.capabilities],
    regions: [...m.regions],
    data: [...m.data],
    network: [...m.network],
  };
}

export class PluginsService {
  private readonly db: Database;
  private readonly registry: PluginRegistry;
  private readonly clubs: ClubsService;
  private readonly encryption: FieldEncryption;
  private readonly logger: Logger | undefined;
  private readonly send: Send;
  private readonly now: () => Date;
  private readonly timeoutMs: number | undefined;

  constructor(
    db: Database,
    deps: {
      registry: PluginRegistry;
      clubs: ClubsService;
      encryption: FieldEncryption;
      logger?: Logger;
      send?: Send;
      now?: () => Date;
      timeoutMs?: number;
    },
  ) {
    this.db = db;
    this.registry = deps.registry;
    this.clubs = deps.clubs;
    this.encryption = deps.encryption;
    this.logger = deps.logger;
    this.send = deps.send ?? fetchSend;
    this.now = deps.now ?? (() => new Date());
    this.timeoutMs = deps.timeoutMs;
  }

  /** The installation's plugins (operators). */
  installed(): { items: InstalledPlugin[]; pluginApi: string } {
    return { items: this.registry.all().map(installedPlugin), pluginApi: PLUGIN_API_VERSION };
  }

  /** The IDs of the plugins the club has enabled (installed ones only). */
  enabledPluginIds(context: TenantContext): Promise<string[]> {
    return this.db.withTenant(context, async (tx) =>
      (await repo.clubPlugins(tx))
        .filter((r) => r.enabled && this.registry.get(r.pluginId))
        .map((r) => r.pluginId),
    );
  }

  /** The plugins for the club's country, with the club's settings (secrets by name only). */
  clubPlugins(context: TenantContext, locale: string): Promise<ClubPlugin[]> {
    return this.db.withTenant(context, async (tx) => {
      const club = await this.clubs.getClubInTx(tx, context.clubId);
      const rows = new Map((await repo.clubPlugins(tx)).map((r) => [r.pluginId, r]));
      const set = await repo.secretNames(tx);
      return this.registry.forCountry(club.country).map((plugin) => {
        const row = rows.get(plugin.manifest.id);
        const names = new Set(
          set.filter((s) => s.pluginId === plugin.manifest.id).map((s) => s.name),
        );
        return {
          ...installedPlugin(plugin),
          enabled: row?.enabled ?? false,
          config: row?.config ?? {},
          configFields: plugin.manifest.config.map((f) => ({
            key: f.key,
            type: f.type,
            label: f.label,
            required: f.required,
            ...(f.options ? { options: f.options } : {}),
            ...(f.pattern ? { pattern: f.pattern } : {}),
            ...(f.maxLength ? { maxLength: f.maxLength } : {}),
          })),
          secrets: plugin.manifest.secrets.map((name) => ({ name, set: names.has(name) })),
          texts: textsIn(plugin, locale),
        };
      });
    });
  }

  /** Enables, disables or configures a plugin for the club; secrets are encrypted with the club's key. */
  async putClubPlugin(
    context: TenantContext,
    pluginId: string,
    input: PutClubPluginInput,
  ): Promise<void> {
    const data = parseInput(PutClubPluginSchema, input);
    const plugin = this.registry.get(pluginId);
    if (!plugin) throw new DomainError("plugin_not_installed");
    const declared = new Set(plugin.manifest.secrets);
    if (Object.keys(data.secrets).some((name) => !declared.has(name))) {
      throw new DomainError("plugin_secret_unknown");
    }
    const config = validateConfig(
      plugin.manifest.config,
      Object.fromEntries(Object.entries(data.config).filter(([, v]) => v !== null)),
    );
    if (!config.ok) throw new DomainError("plugin_config_invalid");
    await this.db.withTenant(context, async (tx) => {
      const club = await this.clubs.getClubInTx(tx, context.clubId);
      if (!servesCountry(plugin, club.country)) throw new DomainError("plugin_wrong_country");
      const before = await repo.clubPlugin(tx, pluginId);
      await repo.upsertClubPlugin(tx, pluginId, data.enabled, config.values);
      const changedSecrets: string[] = [];
      const entries: [string, string | null][] = Object.entries(data.secrets);
      for (const [name, value] of entries) {
        if (value === null) {
          if (await repo.deleteSecret(tx, pluginId, name)) changedSecrets.push(name);
        } else {
          const ciphertext = await this.encryption.encrypt(
            tx,
            context.clubId,
            value,
            secretAad(context.clubId, pluginId, name),
          );
          await repo.setSecret(tx, pluginId, name, ciphertext);
          changedSecrets.push(name);
        }
      }
      const configChanged = JSON.stringify(before?.config ?? {}) !== JSON.stringify(config.values);
      if ((before?.enabled ?? false) !== data.enabled) {
        await audit.record(tx, {
          action: data.enabled ? "plugin.enabled" : "plugin.disabled",
          resourceType: "club",
          resourceId: context.clubId,
          changedFields: [pluginId],
        });
      }
      if (configChanged || changedSecrets.length) {
        await audit.record(tx, {
          action: "plugin.configured",
          resourceType: "club",
          resourceId: context.clubId,
          changedFields: [
            pluginId,
            ...(configChanged ? ["config"] : []),
            ...changedSecrets.map((name) => `secret:${name}`),
          ],
        });
      }
    });
  }

  /**
   * Calls an enabled plugin of the club. The settings are read in one short
   * transaction; the call itself runs outside it (each state access is its
   * own short transaction), validated against `schema` and contained.
   */
  async run<T>(
    context: TenantContext,
    pluginId: string,
    call: (plugin: Plugin, ctx: PluginContext) => Promise<unknown>,
    schema: z.ZodType<T>,
  ): Promise<PluginCallResult<T>> {
    const plugin = this.registry.get(pluginId);
    if (!plugin) throw new DomainError("plugin_not_installed");
    const settings = await this.db.withTenant(context, async (tx) => {
      const club = await this.clubs.getClubInTx(tx, context.clubId);
      const row = await repo.clubPlugin(tx, pluginId);
      if (!row?.enabled) throw new DomainError("plugin_disabled");
      const secrets: Record<string, string> = {};
      for (const s of await repo.secrets(tx, pluginId)) {
        secrets[s.name] = await this.encryption.decrypt(
          tx,
          s.value,
          secretAad(context.clubId, pluginId, s.name),
        );
      }
      return { club, config: row.config, secrets };
    });
    const state = {
      get: (key: string) =>
        this.db.withTenant(context, (tx) =>
          repo.stateGet(tx, pluginId, key),
        ) as Promise<JsonValue | null>,
      set: (key: string, value: JsonValue) =>
        this.db.withTenant(context, (tx) => repo.stateSet(tx, pluginId, key, value)),
      delete: (key: string) =>
        this.db.withTenant(context, (tx) => repo.stateDelete(tx, pluginId, key)),
    };
    const refused: string[] = [];
    const ctx: PluginContext = {
      club: {
        id: context.clubId,
        country: settings.club.country,
        timeZone: settings.club.timeZone,
        locale: settings.club.defaultLocale,
      },
      config: settings.config,
      secrets: settings.secrets,
      now: this.now,
      log: safeLogger((level, event, fields) =>
        this.logger?.[level]({ pluginId, clubId: context.clubId, event, ...fields }, "plugin log"),
      ),
      http: restrictedHttp(plugin.manifest.network, this.send, (host) => refused.push(host)),
      state,
    };
    const result = await callPlugin(() => call(plugin, ctx), schema, this.timeoutMs);
    if (!result.ok || refused.length) {
      this.logger?.warn(
        {
          pluginId,
          clubId: context.clubId,
          error: result.ok ? "plugin_network_refused" : result.error,
          detail: result.ok ? refused.join(",") : result.detail,
          ms: result.ms,
        },
        "plugin call failed",
      );
      await this.db.withTenant(context, (tx) =>
        audit.record(tx, {
          action: "plugin.call_failed",
          resourceType: "club",
          resourceId: context.clubId,
          changedFields: [pluginId, result.ok ? "plugin_network_refused" : result.error],
        }),
      );
    }
    return result;
  }

  /** The background-check types and requirements of the club's enabled plugins (P2.8 builds the screens). */
  async backgroundCheckTypes(
    context: TenantContext,
    locale: string,
  ): Promise<BackgroundCheckTypes> {
    const enabled = await this.enabledPluginIds(context);
    const out: BackgroundCheckTypes = { items: [], requirements: [], unavailable: [] };
    for (const pluginId of enabled) {
      const plugin = this.registry.get(pluginId);
      if (!plugin?.backgroundChecks) continue;
      const result = await this.run(
        context,
        pluginId,
        async (p, ctx) => ({
          types: await p.backgroundChecks!.checkTypes(ctx),
          requirements: await p.backgroundChecks!.requirements(ctx),
        }),
        z.object({ types: z.array(CheckTypeSchema), requirements: z.array(RequirementSchema) }),
      );
      if (!result.ok) {
        out.unavailable.push(pluginId);
        continue;
      }
      const texts = textsIn(plugin, locale);
      const text = (key: string) => texts[key] ?? key;
      out.items.push(
        ...result.value.types.map((t: CheckType) => ({
          pluginId,
          key: t.key,
          name: text(t.name),
          initiator: t.initiator,
          maxAgeDaysWhenPresented: t.maxAgeDaysWhenPresented,
          recheckMonths: t.recheckMonths,
          minAge: t.minAge,
          methods: [...t.methods],
        })),
      );
      out.requirements.push(
        ...result.value.requirements.map((r: Requirement) => ({
          pluginId,
          category: r.category,
          checkType: r.checkType,
          level: r.level,
          basis: text(r.basis),
        })),
      );
    }
    return out;
  }
}
