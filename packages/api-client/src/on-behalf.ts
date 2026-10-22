// SPDX-License-Identifier: AGPL-3.0-only
// When a guardian is "viewing as" a ward, which API calls are made for the
// ward (X-On-Behalf-Of). Shared by the web BFF and the mobile app.

/**
 * Whether a call is made for the ward while "viewing as" one: everything
 * except the logged-in person's own account (who they are, their wards,
 * sessions and preferences) and public metadata.
 */
export function onBehalfApplies(path: string): boolean {
  const pathname = path.split("?")[0]!.replace(/\/+$/, "");
  if (pathname === "/api/v1/me") return false;
  return !/^\/api\/v1\/(me\/(wards|sessions|preferences|security)|meta|dev)(\/|$)/.test(pathname);
}
