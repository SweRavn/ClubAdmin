// SPDX-License-Identifier: AGPL-3.0-only
// Who is calling, as resolved from the access token by the AuthGuard (identity
// module) and stored on the request. Here in the platform layer because the
// identity and authorization modules both use it.

export interface Principal {
  /** Null for DEV_AUTH personas without a login (children). */
  accountId: string | null;
  personId: string;
  /** Logged in with a second factor (amr). */
  mfa: boolean;
  authTime: Date | null;
  /** Identity-provider session (Zitadel sid; DEV_AUTH: the BFF session). */
  sessionId: string | null;
  dev: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}
