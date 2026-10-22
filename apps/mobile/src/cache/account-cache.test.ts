// SPDX-License-Identifier: AGPL-3.0-only
import type { SecureStorage } from "../auth/tokens.ts";
import { openAccountCache, wipeAccountCache } from "./account-cache.ts";

jest.mock("expo-crypto", () => ({
  getRandomBytes: (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 37) % 256),
}));
jest.mock("expo-file-system", () => ({ Paths: { cache: { uri: "file:///cache/" } } }));

function memoryStore(): SecureStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    get: (key) => Promise.resolve(values.get(key) ?? null),
    set: (key, value) => {
      values.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => {
      values.delete(key);
      return Promise.resolve();
    },
  };
}

describe("account cache", () => {
  it("keeps one encrypted store per account with its own key in the secure store", async () => {
    const secure = memoryStore();
    const anna = await openAccountCache("anna", secure);
    anna.setItem("queries", "anna's data");
    expect(anna.getItem("queries")).toBe("anna's data");
    expect(secure.values.get("clubadmin.cache-key.anna")).toHaveLength(32);

    const erik = await openAccountCache("erik", secure);
    expect(erik.getItem("queries")).toBeNull();
  });

  it("wipes the data and the key on logout", async () => {
    const secure = memoryStore();
    const cache = await openAccountCache("liam", secure);
    cache.setItem("queries", "cached roster");
    await wipeAccountCache("liam", secure);
    expect(secure.values.has("clubadmin.cache-key.liam")).toBe(false);
    expect(cache.getItem("queries")).toBeNull();
  });
});
