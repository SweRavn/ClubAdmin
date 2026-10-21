// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  createKeyring,
  CryptoError,
  decryptField,
  encryptField,
  generateKeyBase64,
  parseMasterKeys,
  sealedKeyId,
} from "./crypto.ts";

const blindIndexKey = generateKeyBase64();

describe("envelope encryption", () => {
  const masterKeys = parseMasterKeys(`k2:${generateKeyBase64()}, k1:${generateKeyBase64()}`);
  const keyring = createKeyring({ masterKeys, blindIndexKey });

  it("round-trips a field through a wrapped data key", () => {
    const { key, wrapped } = keyring.generateDataKey("dk-1");
    expect(sealedKeyId(wrapped)).toBe("k2");
    const ciphertext = encryptField(key, "dk-1", "193512208194", "people.pin:abc");
    expect(ciphertext).not.toContain("193512208194");
    expect(sealedKeyId(ciphertext)).toBe("dk-1");
    const unwrapped = keyring.unwrapDataKey("dk-1", wrapped);
    expect(decryptField(unwrapped, ciphertext, "people.pin:abc")).toBe("193512208194");
  });

  it("uses a fresh IV every time", () => {
    const { key } = keyring.generateDataKey("dk-1");
    expect(encryptField(key, "dk-1", "x", "a")).not.toBe(encryptField(key, "dk-1", "x", "a"));
  });

  it("refuses the wrong context, tampering and the wrong data key ID", () => {
    const { key, wrapped } = keyring.generateDataKey("dk-1");
    const ciphertext = encryptField(key, "dk-1", "secret", "people.pin:abc");
    expect(() => decryptField(key, ciphertext, "people.pin:other")).toThrow(CryptoError);
    const parts = ciphertext.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptField(key, parts.join("."), "people.pin:abc")).toThrow(CryptoError);
    expect(() => keyring.unwrapDataKey("dk-2", wrapped)).toThrow(CryptoError);
    try {
      decryptField(key, ciphertext, "people.pin:other");
    } catch (error) {
      expect((error as Error).message).not.toContain("secret");
    }
  });

  it("rewraps data keys when the master key rotates", () => {
    const [k1] = parseMasterKeys(`k1:${generateKeyBase64()}`);
    const [k3] = parseMasterKeys(`k3:${generateKeyBase64()}`);
    const old = createKeyring({ masterKeys: [k1!], blindIndexKey });
    const { key, wrapped } = old.generateDataKey("dk-9");

    const rotated = createKeyring({ masterKeys: [k3!, k1!], blindIndexKey });
    expect(rotated.unwrapDataKey("dk-9", wrapped)).toEqual(key);
    const rewrapped = rotated.rewrapDataKey("dk-9", wrapped);
    expect(sealedKeyId(rewrapped)).toBe("k3");

    const onlyNew = createKeyring({ masterKeys: [k3!], blindIndexKey });
    expect(onlyNew.unwrapDataKey("dk-9", rewrapped)).toEqual(key);
    expect(() => onlyNew.unwrapDataKey("dk-9", wrapped)).toThrow(/unknown master key/);
  });

  it("produces stable, purpose-separated blind indexes", () => {
    const a = keyring.blindIndex("personal_identity_number", "193512208194");
    expect(a).toBe(keyring.blindIndex("personal_identity_number", "193512208194"));
    expect(a).not.toBe(keyring.blindIndex("other", "193512208194"));
    expect(a).not.toContain("1935");
  });

  it("validates configuration", () => {
    expect(() => parseMasterKeys("")).toThrow(/empty/);
    expect(() => parseMasterKeys("nokey")).toThrow(/id:base64key/);
    expect(() => parseMasterKeys("k:c2hvcnQ=")).toThrow(/32 bytes/);
    const key = generateKeyBase64();
    expect(() => parseMasterKeys(`a:${key},a:${key}`)).toThrow(/duplicate/);
  });
});
