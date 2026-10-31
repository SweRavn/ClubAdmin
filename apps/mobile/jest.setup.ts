// SPDX-License-Identifier: AGPL-3.0-only
// Native modules the unit tests do not exercise.

jest.mock("expo-secure-store", () => {
  const values = new Map<string, string>();
  return {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
    getItemAsync: jest.fn((key: string) => Promise.resolve(values.get(key) ?? null)),
    setItemAsync: jest.fn((key: string, value: string) => {
      values.set(key, value);
      return Promise.resolve();
    }),
    deleteItemAsync: jest.fn((key: string) => {
      values.delete(key);
      return Promise.resolve();
    }),
  };
});

jest.mock("expo-screen-capture", () => ({
  preventScreenCaptureAsync: jest.fn(() => Promise.resolve()),
  allowScreenCaptureAsync: jest.fn(() => Promise.resolve()),
  enableAppSwitcherProtectionAsync: jest.fn(() => Promise.resolve()),
  disableAppSwitcherProtectionAsync: jest.fn(() => Promise.resolve()),
}));

// react-native-mmkv uses its in-memory mock under Jest; only the import of
// the native module system needs a stand-in.
jest.mock("react-native-nitro-modules", () => ({
  NitroModules: {
    createHybridObject: () => {
      throw new Error("no native modules in unit tests");
    },
  },
}));

jest.mock("expo-notifications", () => ({
  AndroidImportance: { DEFAULT: 3 },
  PermissionStatus: { GRANTED: "granted", DENIED: "denied", UNDETERMINED: "undetermined" },
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(() => Promise.resolve(null)),
  getPermissionsAsync: jest.fn(() => Promise.resolve({ status: "undetermined" })),
  requestPermissionsAsync: jest.fn(() => Promise.resolve({ status: "denied" })),
  getExpoPushTokenAsync: jest.fn(() => Promise.resolve({ data: "ExponentPushToken[test]" })),
  getLastNotificationResponseAsync: jest.fn(() => Promise.resolve(null)),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
}));
