// SPDX-License-Identifier: AGPL-3.0-only
// Signature providers (P2.4 part C, ADR 0049 decision 6; plugin capability,
// ADR 0051). A provider confirms that a person signs exactly the given hash
// of a document version and says at which level. The in-app provider is a
// simple electronic signature: the API has already required a recent login
// with a second factor, so it records the signature as it is. BankID, Freja
// and the EU wallet implement the same interface later (a redirect or app
// flow before `sign` returns); a club cannot require a level yet.

export type SignatureLevel = "simple";

export interface SignatureRequest {
  clubId: string;
  versionId: string;
  signerPersonId: string;
  /** SHA-256 (hex) of exactly the signed version. */
  sha256: string;
}

export interface SignatureResult {
  provider: string;
  level: SignatureLevel;
  signedAt: Date;
}

export interface SignatureProvider {
  /** Stable name stored with each signature (`in_app`, later `bankid`, `freja`, ...). */
  readonly id: string;
  sign(request: SignatureRequest): Promise<SignatureResult>;
}

/** The simple electronic signature in the app (the caller checked MFA and recent login). */
export function inAppSignatureProvider(now: () => Date = () => new Date()): SignatureProvider {
  return {
    id: "in_app",
    sign: () => Promise.resolve({ provider: "in_app", level: "simple", signedAt: now() }),
  };
}
