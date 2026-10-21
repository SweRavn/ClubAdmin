// SPDX-License-Identifier: AGPL-3.0-only
// Field-level encryption for the services: data keys live wrapped in
// crypto.data_keys (one per club, plus a global one), unwrapped keys are
// cached in memory by key ID.

import { dataKeyStore, type Tx } from "@clubadmin/db";
import {
  createKeyring,
  decryptField,
  encryptField,
  type Keyring,
  parseMasterKeys,
  sealedKeyId,
} from "@clubadmin/server-kit/crypto";

import { DomainError } from "../domain/domain-error.ts";

export const FIELD_ENCRYPTION = Symbol("FIELD_ENCRYPTION");

export class FieldEncryption {
  private readonly keyring: Keyring | undefined;
  private readonly keys = new Map<string, Buffer>();

  constructor(keyring: Keyring | undefined) {
    this.keyring = keyring;
  }

  static fromConfig(config: {
    ENCRYPTION_MASTER_KEYS?: string | undefined;
    BLIND_INDEX_KEY?: string | undefined;
  }): FieldEncryption {
    if (!config.ENCRYPTION_MASTER_KEYS || !config.BLIND_INDEX_KEY)
      return new FieldEncryption(undefined);
    return new FieldEncryption(
      createKeyring({
        masterKeys: parseMasterKeys(config.ENCRYPTION_MASTER_KEYS),
        blindIndexKey: config.BLIND_INDEX_KEY,
      }),
    );
  }

  get available(): boolean {
    return this.keyring !== undefined;
  }

  private requireKeyring(): Keyring {
    if (!this.keyring) throw new DomainError("encryption_unavailable");
    return this.keyring;
  }

  /** Encrypts with the active key of the club, or the global key (clubId null). */
  async encrypt(tx: Tx, clubId: string | null, plaintext: string, aad: string): Promise<string> {
    const keyring = this.requireKeyring();
    const stored = await dataKeyStore.getOrCreateActive(tx, clubId, (id) => {
      const generated = keyring.generateDataKey(id);
      this.keys.set(id, generated.key);
      return generated.wrapped;
    });
    return encryptField(
      this.unwrap(keyring, stored.id, stored.wrappedKey),
      stored.id,
      plaintext,
      aad,
    );
  }

  async decrypt(tx: Tx, ciphertext: string, aad: string): Promise<string> {
    const keyring = this.requireKeyring();
    const keyId = sealedKeyId(ciphertext);
    let key = this.keys.get(keyId);
    if (!key) {
      const stored = await dataKeyStore.findById(tx, keyId);
      if (!stored) throw new DomainError("encryption_unavailable");
      key = this.unwrap(keyring, stored.id, stored.wrappedKey);
    }
    return decryptField(key, ciphertext, aad);
  }

  blindIndex(purpose: string, normalizedValue: string): string {
    return this.requireKeyring().blindIndex(purpose, normalizedValue);
  }

  private unwrap(keyring: Keyring, id: string, wrapped: string): Buffer {
    let key = this.keys.get(id);
    if (!key) {
      key = keyring.unwrapDataKey(id, wrapped);
      this.keys.set(id, key);
    }
    return key;
  }
}
