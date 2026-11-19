// SPDX-License-Identifier: AGPL-3.0-only
// A club's plugins, their encrypted secrets and their state (P2.7). Every
// query runs in the caller's tenant transaction and starts from the club's
// unique (club, plugin) keys.

import { sql, type Tx } from "@clubadmin/db";

export interface ClubPluginRow {
  pluginId: string;
  enabled: boolean;
  config: Record<string, string | number | boolean>;
}

export async function clubPlugins(tx: Tx): Promise<ClubPluginRow[]> {
  const { rows } = await tx.execute<{
    plugin_id: string;
    enabled: boolean;
    config: ClubPluginRow["config"];
  }>(sql`
    SELECT plugin_id, enabled, config FROM public.club_plugins
    WHERE club_id = app.current_club_id() ORDER BY plugin_id`);
  return rows.map((r) => ({ pluginId: r.plugin_id, enabled: r.enabled, config: r.config }));
}

export async function clubPlugin(tx: Tx, pluginId: string): Promise<ClubPluginRow | null> {
  const { rows } = await tx.execute<{ enabled: boolean; config: ClubPluginRow["config"] }>(sql`
    SELECT enabled, config FROM public.club_plugins
    WHERE club_id = app.current_club_id() AND plugin_id = ${pluginId}`);
  const row = rows[0];
  return row ? { pluginId, enabled: row.enabled, config: row.config } : null;
}

export async function upsertClubPlugin(
  tx: Tx,
  pluginId: string,
  enabled: boolean,
  config: ClubPluginRow["config"],
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO public.club_plugins (club_id, plugin_id, enabled, config)
    VALUES (app.current_club_id(), ${pluginId}, ${enabled}, ${JSON.stringify(config)}::jsonb)
    ON CONFLICT (club_id, plugin_id)
    DO UPDATE SET enabled = excluded.enabled, config = excluded.config`);
}

/** The names of the secrets set, per plugin. */
export async function secretNames(tx: Tx): Promise<{ pluginId: string; name: string }[]> {
  const { rows } = await tx.execute<{ plugin_id: string; name: string }>(sql`
    SELECT plugin_id, name FROM public.club_plugin_secrets
    WHERE club_id = app.current_club_id() ORDER BY plugin_id, name`);
  return rows.map((r) => ({ pluginId: r.plugin_id, name: r.name }));
}

export async function secrets(
  tx: Tx,
  pluginId: string,
): Promise<{ name: string; value: string }[]> {
  const { rows } = await tx.execute<{ name: string; value: string }>(sql`
    SELECT name, value FROM public.club_plugin_secrets
    WHERE club_id = app.current_club_id() AND plugin_id = ${pluginId}`);
  return rows;
}

export async function setSecret(
  tx: Tx,
  pluginId: string,
  name: string,
  ciphertext: string,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO public.club_plugin_secrets (club_id, plugin_id, name, value)
    VALUES (app.current_club_id(), ${pluginId}, ${name}, ${ciphertext})
    ON CONFLICT (club_id, plugin_id, name) DO UPDATE SET value = excluded.value`);
}

export async function deleteSecret(tx: Tx, pluginId: string, name: string): Promise<boolean> {
  const result = await tx.execute(sql`
    DELETE FROM public.club_plugin_secrets
    WHERE club_id = app.current_club_id() AND plugin_id = ${pluginId} AND name = ${name}`);
  return (result.rowCount ?? 0) > 0;
}

export async function stateGet(tx: Tx, pluginId: string, key: string): Promise<unknown> {
  const { rows } = await tx.execute<{ value: unknown }>(sql`
    SELECT value FROM public.plugin_state
    WHERE club_id = app.current_club_id() AND plugin_id = ${pluginId} AND key = ${key}`);
  return rows[0]?.value ?? null;
}

export async function stateSet(
  tx: Tx,
  pluginId: string,
  key: string,
  value: unknown,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO public.plugin_state (club_id, plugin_id, key, value)
    VALUES (app.current_club_id(), ${pluginId}, ${key}, ${JSON.stringify(value)}::jsonb)
    ON CONFLICT (club_id, plugin_id, key) DO UPDATE SET value = excluded.value`);
}

export async function stateDelete(tx: Tx, pluginId: string, key: string): Promise<void> {
  await tx.execute(sql`
    DELETE FROM public.plugin_state
    WHERE club_id = app.current_club_id() AND plugin_id = ${pluginId} AND key = ${key}`);
}

/** Every club that is not archived (a background job, no club context). */
export async function activeClubIds(tx: Tx): Promise<string[]> {
  const { rows } = await tx.execute<{ id: string }>(sql`
    SELECT id FROM public.clubs WHERE status <> 'archived' ORDER BY id`);
  return rows.map((r) => r.id);
}
