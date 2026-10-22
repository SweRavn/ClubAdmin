// SPDX-License-Identifier: AGPL-3.0-only
// DEV_AUTH (docs/seed-data.md): log in as any person without the identity
// provider. Tokens are signed with a shared development key. Allowed only in
// development on a self-hosted deployment; the API and the web app refuse to
// start otherwise.

export const DEV_AUTH_ISSUER = "clubadmin-dev";
export const DEV_AUTH_AUDIENCE = "clubadmin-api";
/** Subject prefix of development tokens: `dev:<personId>`. */
export const DEV_AUTH_SUBJECT_PREFIX = "dev:";
/** Client (`azp`) of development tokens minted for the mobile app (POST /dev/tokens). */
export const DEV_AUTH_MOBILE_CLIENT = "clubadmin-dev-mobile";

export interface DevAuthSettings {
  DEV_AUTH: boolean;
  NODE_ENV: string;
  DEPLOYMENT_MODE: string;
}

/** Why DEV_AUTH must not be on with these settings, or null if it is allowed (or off). */
export function devAuthViolation(settings: DevAuthSettings): string | null {
  if (!settings.DEV_AUTH) return null;
  if (settings.NODE_ENV !== "development") {
    return `DEV_AUTH=true requires NODE_ENV=development (is ${settings.NODE_ENV})`;
  }
  if (settings.DEPLOYMENT_MODE === "hosted")
    return "DEV_AUTH=true is not allowed with DEPLOYMENT_MODE=hosted";
  return null;
}

export const DEV_AUTH_WARNING =
  "DEV_AUTH is enabled: anyone who can reach this server can log in as any person. Development only.";
