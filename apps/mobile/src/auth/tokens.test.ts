// SPDX-License-Identifier: AGPL-3.0-only
import {
  LOGIN_KEY,
  LoginEndedError,
  type SecureStorage,
  type StoredLogin,
  TokenManager,
  type TokenRenewer,
  type TokenSet,
} from "./tokens.ts";

function memoryStore(): SecureStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    get: (key) => Promise.resolve(values.get(key) ?? null),
    set: (key, value) => {
      values.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => {
      values.delete(key);
      return Promise.resolve();
    },
  };
}

const tokens = (name: string, expiresAt: number): TokenSet => ({
  accessToken: name,
  idToken: `id-${name}`,
  expiresAt,
});

const oidc: StoredLogin = { kind: "oidc", personId: "p1", refreshToken: "r1", idToken: "id-0" };

describe("TokenManager", () => {
  it("returns the current token until shortly before it expires, then refreshes with rotation", async () => {
    let now = 1_000_000;
    const store = memoryStore();
    const refresh = jest.fn((refreshToken: string) =>
      Promise.resolve({ tokens: tokens(`a-${refreshToken}`, now + 600_000), refreshToken: "r2" }),
    );
    const renewer: TokenRenewer = { refresh, devTokens: jest.fn() };
    const manager = new TokenManager(store, renewer, () => now);
    await manager.signedInWith(oidc, tokens("a0", now + 600_000));

    expect((await manager.current()).accessToken).toBe("a0");
    expect(refresh).not.toHaveBeenCalled();

    now += 560_000; // within a minute of expiry
    expect((await manager.current()).accessToken).toBe("a-r1");
    // The rotated refresh token replaces the old one in the secure store.
    expect(JSON.parse(store.values.get(LOGIN_KEY)!)).toMatchObject({ refreshToken: "r2" });
    expect(manager.refreshToken).toBe("r2");
  });

  it("shares one refresh between concurrent callers", async () => {
    let resolve: (value: { tokens: TokenSet; refreshToken: string }) => void = () => undefined;
    const refresh = jest.fn(
      () =>
        new Promise<{ tokens: TokenSet; refreshToken: string }>((r) => {
          resolve = r;
        }),
    );
    const renewer: TokenRenewer = { refresh, devTokens: jest.fn() };
    const manager = new TokenManager(memoryStore(), renewer);
    await manager.signedInWith(oidc, tokens("old", 0));
    const calls = [manager.current(), manager.renew(), manager.current()];
    resolve({ tokens: tokens("new", Date.now() + 600_000), refreshToken: "r2" });
    const results = await Promise.all(calls);
    expect(results.map((r) => r.accessToken)).toEqual(["new", "new", "new"]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("ends the login cleanly when the refresh token is refused", async () => {
    const store = memoryStore();
    const renewer: TokenRenewer = {
      refresh: () => Promise.reject(new LoginEndedError()),
      devTokens: jest.fn(),
    };
    const manager = new TokenManager(store, renewer);
    const ended = jest.fn();
    manager.onLoginEnded(ended);
    await manager.signedInWith(oidc, tokens("old", 0));
    await expect(manager.current()).rejects.toBeInstanceOf(LoginEndedError);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(manager.signedIn).toBe(false);
    expect(store.values.has(LOGIN_KEY)).toBe(false);
  });

  it("keeps the login on other refresh errors (offline)", async () => {
    const renewer: TokenRenewer = {
      refresh: () => Promise.reject(new TypeError("Network request failed")),
      devTokens: jest.fn(),
    };
    const manager = new TokenManager(memoryStore(), renewer);
    await manager.signedInWith(oidc, tokens("old", 0));
    await expect(manager.current()).rejects.toBeInstanceOf(TypeError);
    expect(manager.signedIn).toBe(true);
  });

  it("asks for new development tokens for DEV_AUTH logins (no refresh token)", async () => {
    const refresh = jest.fn();
    const devTokens = jest.fn(() => Promise.resolve(tokens("dev2", Date.now() + 600_000)));
    const renewer: TokenRenewer = { refresh, devTokens };
    const manager = new TokenManager(memoryStore(), renewer);
    await manager.signedInWith({ kind: "dev", personId: "p2", mfa: true }, tokens("dev1", 0));
    expect((await manager.current()).accessToken).toBe("dev2");
    expect(devTokens).toHaveBeenCalledWith("p2", true);
    expect(refresh).not.toHaveBeenCalled();
    expect(manager.refreshToken).toBeNull();
  });

  it("restores a stored login and forgets it on end", async () => {
    const store = memoryStore();
    store.values.set(LOGIN_KEY, JSON.stringify(oidc));
    const manager = new TokenManager(store, { refresh: jest.fn(), devTokens: jest.fn() });
    expect(await manager.restore()).toBe(true);
    expect(manager.personId).toBe("p1");
    expect(manager.kind).toBe("oidc");
    await manager.end();
    expect(manager.signedIn).toBe(false);
    expect(store.values.size).toBe(0);
  });
});
