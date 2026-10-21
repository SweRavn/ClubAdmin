// SPDX-License-Identifier: AGPL-3.0-only
// Field-level envelope encryption (docs/security.md): sensitive fields are
// encrypted with AES-256-GCM under a data key; data keys are stored wrapped
// (encrypted) by a master key that lives outside the database (config or a
// secret store). Rotating the master key only rewraps data keys.
//
// Formats (dot-separated, base64url parts, versioned):
//   wrapped data key: v1.<masterKeyId>.<iv>.<ciphertext>.<tag>
//   field ciphertext: v1.<dataKeyId>.<iv>.<ciphertext>.<tag>
// The AAD binds a ciphertext to where it belongs (e.g. "people.personal_identity_number:<id>"),
// so a value copied to another row or column does not decrypt.
//
// Matching without decrypting uses a keyed blind index (HMAC-SHA256 with a
// per-purpose key derived from BLIND_INDEX_KEY).

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

const VERSION = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const ALGORITHM = "aes-256-gcm";

export interface MasterKey {
  id: string;
  key: Buffer;
}

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoError";
  }
}

const b64 = (buffer: Buffer) => buffer.toString("base64url");
const unb64 = (value: string) => Buffer.from(value, "base64url");

function decodeKey(value: string, name: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== KEY_BYTES)
    throw new CryptoError(`${name} must be ${KEY_BYTES} bytes, base64-encoded`);
  return key;
}

/**
 * Parses ENCRYPTION_MASTER_KEYS: comma-separated `id:base64key` entries. The
 * first is used for new data keys; the others only to unwrap older ones.
 */
export function parseMasterKeys(spec: string): MasterKey[] {
  const keys = spec
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf(":");
      if (separator < 1)
        throw new CryptoError("ENCRYPTION_MASTER_KEYS entries must be id:base64key");
      const id = entry.slice(0, separator);
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(id))
        throw new CryptoError("master key IDs: 1-32 of A-Z a-z 0-9 _ -");
      return { id, key: decodeKey(entry.slice(separator + 1), `master key "${id}"`) };
    });
  if (keys.length === 0) throw new CryptoError("ENCRYPTION_MASTER_KEYS is empty");
  if (new Set(keys.map((k) => k.id)).size !== keys.length)
    throw new CryptoError("duplicate master key ID");
  return keys;
}

/** A new random 256-bit key, base64 (for generating configuration). */
export const generateKeyBase64 = (): string => randomBytes(KEY_BYTES).toString("base64");

function seal(key: Buffer, keyId: string, plaintext: Buffer, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [VERSION, keyId, b64(iv), b64(ciphertext), b64(cipher.getAuthTag())].join(".");
}

interface Sealed {
  keyId: string;
  iv: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

function parseSealed(value: string): Sealed {
  const parts = value.split(".");
  if (parts.length !== 5 || parts[0] !== VERSION)
    throw new CryptoError("unsupported ciphertext format");
  const [, keyId, iv, ciphertext, tag] = parts as [string, string, string, string, string];
  return { keyId, iv: unb64(iv), ciphertext: unb64(ciphertext), tag: unb64(tag) };
}

function open(key: Buffer, sealed: Sealed, aad: string): Buffer {
  try {
    const decipher = createDecipheriv(ALGORITHM, key, sealed.iv);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(sealed.tag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
  } catch {
    // Never include the value or key in the message.
    throw new CryptoError("decryption failed (wrong key, wrong context or tampered data)");
  }
}

/** The key ID a ciphertext or wrapped key was sealed with. */
export const sealedKeyId = (value: string): string => parseSealed(value).keyId;

export interface Keyring {
  readonly currentMasterKeyId: string;
  /** A new data key and its wrapped form for storage. `dataKeyId` is bound into the wrapping. */
  generateDataKey(dataKeyId: string): { key: Buffer; wrapped: string };
  unwrapDataKey(dataKeyId: string, wrapped: string): Buffer;
  /** Rewraps with the current master key (master key rotation). */
  rewrapDataKey(dataKeyId: string, wrapped: string): string;
  /** Keyed hash for matching a normalised value without decrypting it. */
  blindIndex(purpose: string, normalizedValue: string): string;
}

export function createKeyring(options: {
  masterKeys: MasterKey[];
  blindIndexKey: string;
}): Keyring {
  const [current] = options.masterKeys;
  if (!current) throw new CryptoError("no master key");
  const byId = new Map(options.masterKeys.map((k) => [k.id, k.key]));
  const blindIndexRoot = decodeKey(options.blindIndexKey, "BLIND_INDEX_KEY");
  const blindKeys = new Map<string, Buffer>();
  const aadFor = (dataKeyId: string) => `data-key:${dataKeyId}`;

  const unwrapDataKey = (dataKeyId: string, wrapped: string): Buffer => {
    const sealed = parseSealed(wrapped);
    const master = byId.get(sealed.keyId);
    if (!master) throw new CryptoError(`unknown master key "${sealed.keyId}"`);
    return open(master, sealed, aadFor(dataKeyId));
  };

  return {
    currentMasterKeyId: current.id,
    generateDataKey(dataKeyId) {
      const key = randomBytes(KEY_BYTES);
      return { key, wrapped: seal(current.key, current.id, key, aadFor(dataKeyId)) };
    },
    unwrapDataKey,
    rewrapDataKey(dataKeyId, wrapped) {
      return seal(current.key, current.id, unwrapDataKey(dataKeyId, wrapped), aadFor(dataKeyId));
    },
    blindIndex(purpose, normalizedValue) {
      let key = blindKeys.get(purpose);
      if (!key) {
        key = Buffer.from(
          hkdfSync("sha256", blindIndexRoot, Buffer.alloc(0), `blind-index:${purpose}`, KEY_BYTES),
        );
        blindKeys.set(purpose, key);
      }
      return createHmac("sha256", key).update(normalizedValue, "utf8").digest("base64url");
    },
  };
}

/** Encrypts a field value with a data key. */
export function encryptField(
  dataKey: Buffer,
  dataKeyId: string,
  plaintext: string,
  aad: string,
): string {
  return seal(dataKey, dataKeyId, Buffer.from(plaintext, "utf8"), aad);
}

/** Decrypts a field value; `dataKey` must be the key named by sealedKeyId(ciphertext). */
export function decryptField(dataKey: Buffer, ciphertext: string, aad: string): string {
  return open(dataKey, parseSealed(ciphertext), aad).toString("utf8");
}
