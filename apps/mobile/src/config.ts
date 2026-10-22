// SPDX-License-Identifier: AGPL-3.0-only
// Build-time settings (app.config.ts → extra) and the app's identity.

import Constants from "expo-constants";

import type { AppExtra } from "../app.config.ts";

const extra = (Constants.expoConfig?.extra ?? {}) as Partial<AppExtra>;

/**
 * The build variant as a bundle-time constant (metro.config.js sets it from
 * APP_VARIANT; Expo inlines EXPO_PUBLIC_* variables). Comparisons with it
 * fold away when bundling, so development-only code (the DEV_AUTH persona
 * picker) is not in preview or production bundles; CI checks the bundle.
 */
export const BUILD_VARIANT = process.env.EXPO_PUBLIC_APP_VARIANT;
export const DEV_AUTH_BUILD = process.env.EXPO_PUBLIC_APP_VARIANT === "development";

export const appConfig: AppExtra = {
  variant: extra.variant ?? "production",
  apiUrl: (extra.apiUrl ?? "https://api.clubadmin.localhost").replace(/\/$/, ""),
  authIssuer: (extra.authIssuer ?? "https://auth.clubadmin.localhost").replace(/\/$/, ""),
  authClientId: extra.authClientId ?? "",
  authProjectId: extra.authProjectId ?? "",
  devAuth: DEV_AUTH_BUILD && extra.devAuth === true,
  sourceUrl: extra.sourceUrl ?? "https://github.com/SweRavn/ClubAdmin",
};

export const APP_VERSION = Constants.expoConfig?.version ?? "0.0.0";
