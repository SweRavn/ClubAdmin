// SPDX-License-Identifier: AGPL-3.0-only
// The OS secure store (iOS Keychain, Android Keystore), readable only after
// the device has been unlocked once since boot.

import * as SecureStore from "expo-secure-store";

import type { SecureStorage } from "./tokens.ts";

const options: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export const secureStorage: SecureStorage = {
  get: (key) => SecureStore.getItemAsync(key, options),
  set: (key, value) => SecureStore.setItemAsync(key, value, options),
  delete: (key) => SecureStore.deleteItemAsync(key, options),
};
