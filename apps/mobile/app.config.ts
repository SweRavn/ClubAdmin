// SPDX-License-Identifier: AGPL-3.0-only
// Expo app configuration. APP_VARIANT picks development, preview or
// production: bundle IDs, names and URL schemes differ, so the variants can be
// installed side by side (every scheme's redirect is registered in
// infra/zitadel/clubadmin.json). Server URLs come from the environment at
// build time and default to the local Caddy domains (docs/development.md).

import type { ConfigContext, ExpoConfig } from "expo/config";

import pkg from "./package.json" with { type: "json" };

export type AppVariant = "development" | "preview" | "production";

const VARIANTS: Record<AppVariant, { suffix: string; name: string; scheme: string }> = {
  development: { suffix: ".dev", name: "ClubAdmin Dev", scheme: "clubadmin-dev" },
  preview: { suffix: ".preview", name: "ClubAdmin Preview", scheme: "clubadmin-preview" },
  production: { suffix: "", name: "ClubAdmin", scheme: "clubadmin" },
};

/** What the app reads at run time (src/config.ts). */
export interface AppExtra {
  variant: AppVariant;
  apiUrl: string;
  authIssuer: string;
  authClientId: string;
  /** Zitadel project ID, requested as audience scope (as the web app does). */
  authProjectId: string;
  /** The persona picker; compiled out of preview and production builds. */
  devAuth: boolean;
  sourceUrl: string;
}

export function variantOf(value: string | undefined): AppVariant {
  return value === "preview" || value === "production" ? value : "development";
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const env = process.env;
  const variant = variantOf(env.APP_VARIANT);
  const { suffix, name, scheme } = VARIANTS[variant];
  const appId = `${env.APP_ID ?? "org.clubadmin.app"}${suffix}`;
  const updatesUrl = env.EXPO_UPDATES_URL;
  const extra: AppExtra = {
    variant,
    apiUrl: env.MOBILE_API_URL ?? "https://api.clubadmin.localhost",
    authIssuer: env.AUTH_ISSUER ?? "https://auth.clubadmin.localhost",
    authClientId: env.AUTH_MOBILE_CLIENT_ID ?? "",
    authProjectId: env.AUTH_PROJECT_ID ?? env.AUTH_AUDIENCE ?? "",
    devAuth: variant === "development" && env.DEV_AUTH !== "false",
    sourceUrl: env.SOURCE_URL ?? "https://github.com/SweRavn/ClubAdmin",
  };
  return {
    ...config,
    name,
    slug: "clubadmin",
    ...(env.EXPO_OWNER ? { owner: env.EXPO_OWNER } : {}),
    version: pkg.version,
    scheme,
    orientation: "portrait",
    userInterfaceStyle: "automatic",
    icon: "./assets/icon.png",
    ios: {
      bundleIdentifier: appId,
      supportsTablet: false,
      config: { usesNonExemptEncryption: false },
      infoPlist: {
        NSFaceIDUsageDescription: "Unlock ClubAdmin with Face ID.",
      },
    },
    android: {
      package: appId,
      // The query cache holds names of protected people: never in device backups.
      allowBackup: false,
      adaptiveIcon: { foregroundImage: "./assets/icon.png", backgroundColor: "#1f4e79" },
    },
    // Over-the-air updates (ADR 0028): JavaScript updates reach only builds
    // with the same native code (runtime version from the native fingerprint).
    runtimeVersion: { policy: "fingerprint" },
    updates: {
      enabled: Boolean(updatesUrl),
      ...(updatesUrl ? { url: updatesUrl } : {}),
      checkAutomatically: "ON_LOAD",
      fallbackToCacheTimeout: 0,
    },
    plugins: [
      "expo-router",
      "expo-localization",
      "expo-secure-store",
      ["expo-local-authentication", { faceIDPermission: "Unlock ClubAdmin with Face ID." }],
      // Development builds trust Caddy's local CA (never preview or production).
      ["./plugins/with-development-ca.ts", { enabled: variant === "development" }],
    ],
    experiments: { typedRoutes: true },
    extra: { ...extra, router: {} },
  };
};
