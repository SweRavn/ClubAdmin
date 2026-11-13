// SPDX-License-Identifier: AGPL-3.0-only
// When a guardian is "viewing as" a ward, which API calls are made for the
// ward (X-On-Behalf-Of). Shared by the web BFF and the mobile app.

/**
 * Whether a call is made for the ward while "viewing as" one: everything
 * except the logged-in person's own account (who they are, their wards,
 * sessions and preferences), public metadata, and chat: a chat is always
 * the logged-in person's own (ADR 0047; a guardian never reads or writes as
 * a ward, the API refuses chat on behalf of one).
 */
export function onBehalfApplies(path: string): boolean {
  const pathname = path.split("?")[0]!.replace(/\/+$/, "");
  if (pathname === "/api/v1/me") return false;
  if (/^\/api\/v1\/(me\/chats|realtime)(\/|$)/.test(pathname)) return false;
  if (/^\/api\/v1\/clubs\/[^/]+\/(chats|direct-chats|groups\/[^/]+\/chats)(\/|$)/.test(pathname))
    return false;
  return !/^\/api\/v1\/(me\/(wards|sessions|preferences|security)|meta|dev)(\/|$)/.test(pathname);
}
