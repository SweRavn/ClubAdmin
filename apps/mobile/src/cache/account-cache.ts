// SPDX-License-Identifier: AGPL-3.0-only
// The persisted query cache (ADR 0028): one MMKV instance per account,
// encrypted with a random key kept in the secure store, in the app's cache
// directory (never in iCloud or Android backups). It holds names of
// protected people for viewers allowed to see them, so it is wiped with its
// key on logout and when another account logs in, and it is never logged.

import { getRandomBytes } from "expo-crypto";
import { Paths } from "expo-file-system";
import { createMMKV, deleteMMKV, type MMKV } from "react-native-mmkv";

import type { SecureStorage } from "../auth/tokens.ts";

/** Bump when the cached data's shape changes so old caches are discarded. */
export const CACHE_SCHEMA_VERSION = 1;

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const instanceId = (personId: string) => `query-cache-${personId}`;
const keyName = (personId: string) => `clubadmin.cache-key.${personId}`;
const cacheDir = () => `${Paths.cache.uri.replace(/^file:\/\//, "")}mmkv`;

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

let open: { personId: string; mmkv: MMKV } | null = null;

export async function openAccountCache(
  personId: string,
  secure: SecureStorage,
): Promise<KeyValueStorage> {
  let key = await secure.get(keyName(personId));
  if (!key) {
    // 24 random bytes → 32 characters: the AES-256 key size.
    key = toBase64Url(getRandomBytes(24));
    await secure.set(keyName(personId), key);
  }
  const mmkv = createMMKV({
    id: instanceId(personId),
    path: cacheDir(),
    encryptionKey: key,
    encryptionType: "AES-256",
  });
  open = { personId, mmkv };
  return {
    getItem: (k) => mmkv.getString(k) ?? null,
    setItem: (k, value) => mmkv.set(k, value),
    removeItem: (k) => {
      mmkv.remove(k);
    },
  };
}

/** Deletes an account's cache and its key. */
export async function wipeAccountCache(personId: string, secure: SecureStorage): Promise<void> {
  if (open?.personId === personId) {
    open.mmkv.clearAll();
    open = null;
  }
  deleteMMKV(instanceId(personId));
  await secure.delete(keyName(personId));
}
