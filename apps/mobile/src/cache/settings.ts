// SPDX-License-Identifier: AGPL-3.0-only
// Small, non-sensitive app settings (IDs and flags only): the last club per
// person, biometric unlock, dismissed update notices.

import { createMMKV } from "react-native-mmkv";

const settings = createMMKV({ id: "settings" });

export const appSettings = {
  lastClub: (personId: string) => settings.getString(`last-club.${personId}`) ?? null,
  setLastClub: (personId: string, clubId: string) => settings.set(`last-club.${personId}`, clubId),
  viewingAs: (personId: string) => settings.getString(`viewing-as.${personId}`) ?? null,
  setViewingAs: (personId: string, wardId: string | null) => {
    if (wardId) settings.set(`viewing-as.${personId}`, wardId);
    else settings.remove(`viewing-as.${personId}`);
  },
  biometricUnlock: () => settings.getBoolean("biometric-unlock") ?? false,
  setBiometricUnlock: (on: boolean) => settings.set("biometric-unlock", on),
  dismissedUpdate: () => settings.getString("dismissed-update") ?? null,
  setDismissedUpdate: (version: string) => settings.set("dismissed-update", version),
  /** Forgets everything about a person (logout). */
  forget: (personId: string) => {
    settings.remove(`last-club.${personId}`);
    settings.remove(`viewing-as.${personId}`);
  },
};
