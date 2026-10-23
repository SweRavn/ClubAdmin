// SPDX-License-Identifier: AGPL-3.0-only
// The core domain services for integration tests, with field encryption
// using throw-away keys.

import type { Database } from "@clubadmin/db";
import { createKeyring, generateKeyBase64, parseMasterKeys } from "@clubadmin/server-kit/crypto";
import type { ObjectStorage } from "@clubadmin/server-kit/object-storage";

import { type CoreServices, createCoreServices as createServices } from "../domain-services.ts";
import { FieldEncryption } from "../platform/crypto/field-encryption.ts";

export type { CoreServices };

export function testEncryption(): FieldEncryption {
  return new FieldEncryption(
    createKeyring({
      masterKeys: parseMasterKeys(`test:${generateKeyBase64()}`),
      blindIndexKey: generateKeyBase64(),
    }),
  );
}

/** INVITATION_TOKEN_KEY of the integration tests (guardian and own-login invitations need one). */
export const TEST_INVITATION_TOKEN_KEY = "test-invitation-token-key-with-32-characters";

export function createCoreServices(
  db: Database,
  options: {
    encryption?: FieldEncryption;
    defaultCountry?: string;
    invitationTokenKey?: string;
    storage?: ObjectStorage | null;
  } = {},
): CoreServices {
  return createServices(db, {
    ...(options.storage ? { storage: options.storage } : {}),
    encryption: options.encryption ?? testEncryption(),
    ...(options.defaultCountry ? { defaultCountry: options.defaultCountry } : {}),
    invitationTokenKey: options.invitationTokenKey ?? TEST_INVITATION_TOKEN_KEY,
  });
}
