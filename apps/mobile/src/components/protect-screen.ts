// SPDX-License-Identifier: AGPL-3.0-only
// Screens that show people with protected identity to privileged viewers
// (ADR 0022) are kept out of screenshots and screen recordings on Android
// (FLAG_SECURE) and blurred in the iOS app switcher. Other screens allow
// screenshots.

import { useFocusEffect } from "expo-router";
import * as ScreenCapture from "expo-screen-capture";
import { useCallback } from "react";
import { Platform } from "react-native";

export function useProtectScreen(active: boolean, key: string) {
  useFocusEffect(
    useCallback(() => {
      if (!active) return undefined;
      void ScreenCapture.preventScreenCaptureAsync(key).catch(() => undefined);
      if (Platform.OS === "ios") {
        void ScreenCapture.enableAppSwitcherProtectionAsync().catch(() => undefined);
      }
      return () => {
        void ScreenCapture.allowScreenCaptureAsync(key).catch(() => undefined);
        if (Platform.OS === "ios") {
          void ScreenCapture.disableAppSwitcherProtectionAsync().catch(() => undefined);
        }
      };
    }, [active, key]),
  );
}
