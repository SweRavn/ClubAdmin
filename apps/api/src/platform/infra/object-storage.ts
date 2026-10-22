// SPDX-License-Identifier: AGPL-3.0-only
// Object storage (ADR 0011): null when S3_* is not configured; features that
// need it answer "unavailable".
import { ObjectStorage, objectStorageConfig } from "@clubadmin/server-kit/object-storage";

import type { ApiConfig } from "../../config.ts";

export const OBJECT_STORAGE = Symbol("OBJECT_STORAGE");

export type OptionalObjectStorage = ObjectStorage | null;

export function createObjectStorage(config: ApiConfig): OptionalObjectStorage {
  const storage = objectStorageConfig(config);
  return storage ? new ObjectStorage(storage) : null;
}
