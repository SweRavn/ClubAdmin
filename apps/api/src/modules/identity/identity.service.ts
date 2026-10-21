// SPDX-License-Identifier: AGPL-3.0-only
// Maps a verified token to a principal: finds the account by the identity
// provider's subject, creates account and person on the first login
// (provisioning), links a "give own login" invitation, and takes over email
// changes made in Zitadel. Results are cached briefly in memory so that
// validating a request needs no database query.

import { isDomainError } from "../../platform/domain/domain-error.ts";
import { ProblemError } from "../../platform/http/problem-error.ts";
import type { AccountsService } from "../accounts/index.ts";
import type { Principal } from "./principal.ts";
import { isMfa, type VerifiedToken } from "./token-verifier.ts";

interface CachedAccount {
  accountId: string | null;
  personId: string;
  email: string | null;
  expiresAt: number;
}

export interface ResolveOptions {
  requestId?: string;
  /** Client IP, for the provisioning rate limit (never stored). */
  ip?: string;
  /** "Give own login" invitation token, sent by the BFF during sign-up. */
  invitationToken?: string;
}

const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX = 10_000;
/** First logins (account creation) per client IP and minute. */
export const PROVISIONING_LIMIT = 10;

export class IdentityService {
  private readonly accounts: AccountsService;
  private readonly cache = new Map<string, CachedAccount>();
  private readonly provisioning = new Map<string, { count: number; resetAt: number }>();

  constructor(accounts: AccountsService) {
    this.accounts = accounts;
  }

  async resolve(token: VerifiedToken, options: ResolveOptions = {}): Promise<Principal> {
    const account = token.devPersonId
      ? await this.devAccount(token.devPersonId)
      : await this.idpAccount(token, options);
    return {
      accountId: account.accountId,
      personId: account.personId,
      mfa: isMfa(token.amr),
      authTime: token.authTime,
      sessionId: token.sessionId,
      dev: token.devPersonId !== null,
    };
  }

  /** Forget cached mappings (tests, or after an account change). */
  clearCache(): void {
    this.cache.clear();
  }

  private async devAccount(personId: string): Promise<CachedAccount> {
    const key = `dev:${personId}`;
    const cached = this.fromCache(key);
    if (cached) return cached;
    const account = await this.accounts.findByPerson(personId);
    return this.toCache(key, {
      accountId: account?.id ?? null,
      personId,
      email: account?.email ?? null,
    });
  }

  private async idpAccount(token: VerifiedToken, options: ResolveOptions): Promise<CachedAccount> {
    const key = `idp:${token.subject}`;
    let account = this.fromCache(key);
    if (!account) {
      const found = await this.accounts.findBySubject(token.subject);
      account = found
        ? this.toCache(key, { accountId: found.id, personId: found.personId, email: found.email })
        : await this.provision(token, options, key);
    }
    // Email changed in Zitadel (and verified there): take it over.
    const email = token.email?.trim().toLowerCase();
    if (email && token.emailVerified && account.email && email !== account.email) {
      try {
        await this.accounts.syncEmail(
          { actorKind: "person", personId: account.personId, requestId: options.requestId ?? null },
          email,
          new Date(),
        );
        account = this.toCache(key, { ...account, email });
      } catch (error) {
        // Another account has that address: keep the old one, log in anyway.
        if (!isDomainError(error, "email_taken")) throw error;
      }
    }
    return account;
  }

  private async provision(
    token: VerifiedToken,
    options: ResolveOptions,
    key: string,
  ): Promise<CachedAccount> {
    if (!token.email || !token.emailVerified) {
      // The first request after login must carry the ID token (verified email, names).
      throw new ProblemError("unauthenticated", { detail: "verified_email_required" });
    }
    this.limitProvisioning(options.ip ?? "unknown");
    const account = {
      email: token.email,
      emailVerifiedAt: new Date(),
      idpSubject: token.subject,
    };
    const context = { requestId: options.requestId ?? null };
    try {
      const created = options.invitationToken
        ? await this.accounts.acceptOwnLoginInvitation(context, options.invitationToken, account)
        : await this.accounts.signUp(
            context,
            { givenName: token.givenName ?? "-", familyName: token.familyName ?? "-" },
            account,
          );
      return this.toCache(key, {
        accountId: created.id,
        personId: created.personId,
        email: created.email,
      });
    } catch (error) {
      // Another request created it concurrently: use that one.
      if (isDomainError(error, "account_exists")) {
        const found = await this.accounts.findBySubject(token.subject);
        if (found)
          return this.toCache(key, {
            accountId: found.id,
            personId: found.personId,
            email: found.email,
          });
      }
      // email_taken: this address already belongs to another account; no merge by email.
      throw error;
    }
  }

  private limitProvisioning(ip: string): void {
    const now = Date.now();
    const entry = this.provisioning.get(ip);
    if (!entry || entry.resetAt <= now) {
      this.provisioning.set(ip, { count: 1, resetAt: now + 60_000 });
      if (this.provisioning.size > CACHE_MAX) this.provisioning.clear();
      return;
    }
    entry.count += 1;
    if (entry.count > PROVISIONING_LIMIT) throw new ProblemError("rate-limited");
  }

  private fromCache(key: string): CachedAccount | undefined {
    const cached = this.cache.get(key);
    if (!cached) return undefined;
    if (cached.expiresAt > Date.now()) return cached;
    this.cache.delete(key);
    return undefined;
  }

  private toCache(key: string, value: Omit<CachedAccount, "expiresAt">): CachedAccount {
    if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    const entry = { ...value, expiresAt: Date.now() + CACHE_TTL_MS };
    this.cache.set(key, entry);
    return entry;
  }
}
