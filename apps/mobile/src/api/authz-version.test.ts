// SPDX-License-Identifier: AGPL-3.0-only
import { noteAuthzVersion, onAuthzChanged, resetAuthzVersion } from "./authz-version.ts";

describe("authorization version (P1.15 A2)", () => {
  it("tells listeners when the version changes, not on the first one", () => {
    resetAuthzVersion();
    const listener = jest.fn();
    const off = onAuthzChanged(listener);
    noteAuthzVersion("3");
    noteAuthzVersion("3");
    noteAuthzVersion(null);
    expect(listener).not.toHaveBeenCalled();
    noteAuthzVersion("4");
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    noteAuthzVersion("5");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
