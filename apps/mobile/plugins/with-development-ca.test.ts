// SPDX-License-Identifier: AGPL-3.0-only
import { networkSecurityConfig } from "./with-development-ca.ts";

describe("development network security config", () => {
  it("trusts the system store, Caddy's CA and user CAs, never cleartext", () => {
    const xml = networkSecurityConfig(true);
    expect(xml).toContain('src="system"');
    expect(xml).toContain('src="@raw/clubadmin_dev_ca"');
    expect(xml).toContain('src="user"');
    expect(xml).toContain('cleartextTrafficPermitted="false"');
  });

  it("trusts the user store without the exported CA", () => {
    const xml = networkSecurityConfig(false);
    expect(xml).not.toContain("clubadmin_dev_ca");
    expect(xml).toContain('src="user"');
  });
});
