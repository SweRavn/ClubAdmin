// SPDX-License-Identifier: AGPL-3.0-only
// What a form held when its save failed or when "Add a row" was pressed
// without JavaScript (P1.6b): kept for ten minutes per session and form, so
// the page shows every value typed again. Only the forms in
// KEEP_VALUES_ACTIONS (events, groups, club settings), never personal data
// beyond what the person just typed into those forms.

import { createHash } from "node:crypto";

import { valkey } from "./valkey.ts";

export const KEEP_VALUES_ACTIONS = new Set([
  "create-event",
  "update-event",
  "create-group",
  "update-group",
  "update-club-settings",
  "set-club-phone-numbers",
]);

const TTL_SECONDS = 600;
const MAX_BYTES = 64_000;
const SKIPPED = new Set(["csrf", "back", "more"]);

export type FormDraft = ReadonlyMap<string, readonly string[]>;

const keyOf = (sessionId: string, action: string) =>
  `formdraft:${createHash("sha256").update(sessionId).digest("base64url")}:${action}`;

export async function saveFormDraft(sessionId: string, action: string, form: FormData) {
  const entries: [string, string][] = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === "string" && !SKIPPED.has(name)) entries.push([name, value]);
  }
  const json = JSON.stringify(entries);
  if (json.length > MAX_BYTES) return;
  await valkey().set(keyOf(sessionId, action), json, "EX", TTL_SECONDS);
}

export async function loadFormDraft(sessionId: string, action: string): Promise<FormDraft | null> {
  const json = await valkey().get(keyOf(sessionId, action));
  if (!json) return null;
  const draft = new Map<string, string[]>();
  for (const [name, value] of JSON.parse(json) as [string, string][]) {
    draft.set(name, [...(draft.get(name) ?? []), value]);
  }
  return draft;
}

export async function clearFormDraft(sessionId: string, action: string) {
  await valkey().del(keyOf(sessionId, action));
}
