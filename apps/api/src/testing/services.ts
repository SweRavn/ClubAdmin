// SPDX-License-Identifier: AGPL-3.0-only
// The core domain services for integration tests, with field encryption
// using throw-away keys.

import type { Database } from "@clubadmin/db";
import { createKeyring, generateKeyBase64, parseMasterKeys } from "@clubadmin/server-kit/crypto";

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

export function createCoreServices(
  db: Database,
  options: { encryption?: FieldEncryption; defaultCountry?: string } = {},
): CoreServices {
  return createServices(db, {
    encryption: options.encryption ?? testEncryption(),
    ...(options.defaultCountry ? { defaultCountry: options.defaultCountry } : {}),
  });
}
