// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { onBehalfApplies } from "./on-behalf.ts";

describe("onBehalfApplies", () => {
  it.each([
    ["/api/v1/me/clubs", true],
    ["/api/v1/me/groups", true],
    ["/api/v1/groups/x/members?cursor=y", true],
    ["/api/v1/people/x/", true],
    ["/api/v1/me", false],
    ["/api/v1/me/", false],
    ["/api/v1/me/wards", false],
    ["/api/v1/me/sessions/abc", false],
    ["/api/v1/me/preferences", false],
    ["/api/v1/meta/source", false],
    ["/api/v1/meta/client", false],
    ["/api/v1/dev/tokens", false],
    ["/api/v1/me/chats", false],
    ["/api/v1/realtime/tickets", false],
    ["/api/v1/clubs/c/chats/x/messages", false],
    ["/api/v1/clubs/c/direct-chats", false],
    ["/api/v1/clubs/c/groups/g/chats", false],
    ["/api/v1/clubs/c/groups/g/members", true],
  ])("%s → %s", (path, expected) => {
    expect(onBehalfApplies(path)).toBe(expected);
  });
});
