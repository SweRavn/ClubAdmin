// SPDX-License-Identifier: AGPL-3.0-only
// Token handling for the mobile app (ADR 0028). The refresh token lives in
// the OS secure store (Keychain/Keystore); access and ID tokens only in
// memory. Tokens are refreshed shortly before they expire and after a 401,
// one refresh at a time (concurrent callers wait for it). A rejected refresh
// token ends the login cleanly. DEV_AUTH logins have no refresh token: the
// app asks the API for new development tokens instead.

export interface SecureStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface TokenSet {
  accessToken: string;
  idToken: string | null;
  /** Epoch ms. */
  expiresAt: number;
}

/**
 * How a login is kept alive: an OIDC refresh token, or a DEV_AUTH persona.
 * `personId` names the per-account cache, so cached screens can render
 * before the first request.
 */
export type StoredLogin =
  | { kind: "oidc"; personId: string; refreshToken: string; idToken: string | null }
  | { kind: "dev"; personId: string; mfa: boolean };

export interface TokenRenewer {
  /** OIDC: a new token set and the rotated refresh token. Throws LoginEndedError if refused. */
  refresh(refreshToken: string): Promise<{ tokens: TokenSet; refreshToken: string | null }>;
  /** DEV_AUTH: new development tokens for the persona. */
  devTokens(personId: string, mfa: boolean): Promise<TokenSet>;
}

/** The identity provider refused the refresh token (revoked, expired or reused). */
export class LoginEndedError extends Error {
  constructor() {
    super("login ended");
    this.name = "LoginEndedError";
  }
}

export const LOGIN_KEY = "clubadmin.login";
/** Refresh this long before the access token expires. */
const EARLY_MS = 60_000;

export class TokenManager {
  private readonly store: SecureStorage;
  private readonly renewer: TokenRenewer;
  private readonly now: () => number;
  private tokens: TokenSet | null = null;
  private login: StoredLogin | null = null;
  private refreshing: Promise<TokenSet> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(store: SecureStorage, renewer: TokenRenewer, now: () => number = Date.now) {
    this.store = store;
    this.renewer = renewer;
    this.now = now;
  }

  /** Loads a stored login (app start). Returns whether there is one. */
  async restore(): Promise<boolean> {
    const raw = await this.store.get(LOGIN_KEY);
    if (!raw) return false;
    try {
      this.login = JSON.parse(raw) as StoredLogin;
      return true;
    } catch {
      await this.store.delete(LOGIN_KEY);
      return false;
    }
  }

  get signedIn(): boolean {
    return this.login !== null;
  }

  get kind(): StoredLogin["kind"] | null {
    return this.login?.kind ?? null;
  }

  get personId(): string | null {
    return this.login?.personId ?? null;
  }

  /** The ID token for ending the identity-provider session (OIDC logins). */
  get idTokenHint(): string | null {
    return this.tokens?.idToken ?? (this.login?.kind === "oidc" ? this.login.idToken : null);
  }

  /** Called when a login ends (signed out, or the refresh token was refused). */
  onLoginEnded(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async signedInWith(login: StoredLogin, tokens: TokenSet): Promise<void> {
    this.login = login;
    this.tokens = tokens;
    await this.store.set(LOGIN_KEY, JSON.stringify(login));
  }

  /** A valid token set, refreshed if it expires within a minute. */
  async current(): Promise<TokenSet> {
    if (this.tokens && this.tokens.expiresAt - EARLY_MS > this.now()) return this.tokens;
    return this.renew();
  }

  /** Forces a refresh (after a 401); concurrent callers share one refresh. */
  renew(): Promise<TokenSet> {
    this.refreshing ??= this.doRenew().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRenew(): Promise<TokenSet> {
    const login = this.login;
    if (!login) throw new LoginEndedError();
    try {
      if (login.kind === "dev") {
        this.tokens = await this.renewer.devTokens(login.personId, login.mfa);
        return this.tokens;
      }
      const result = await this.renewer.refresh(login.refreshToken);
      this.tokens = result.tokens;
      // Rotation: the old refresh token is now invalid; keep the new one.
      const next: StoredLogin = {
        kind: "oidc",
        personId: login.personId,
        refreshToken: result.refreshToken ?? login.refreshToken,
        idToken: result.tokens.idToken ?? login.idToken,
      };
      this.login = next;
      await this.store.set(LOGIN_KEY, JSON.stringify(next));
      return result.tokens;
    } catch (error) {
      if (error instanceof LoginEndedError) await this.end();
      throw error;
    }
  }

  /** The refresh token, for revoking it at logout. */
  get refreshToken(): string | null {
    return this.login?.kind === "oidc" ? this.login.refreshToken : null;
  }

  /** Forgets the login: tokens from memory and the secure store. */
  async end(): Promise<void> {
    const wasSignedIn = this.login !== null;
    this.login = null;
    this.tokens = null;
    await this.store.delete(LOGIN_KEY);
    if (wasSignedIn) for (const listener of this.listeners) listener();
  }
}
