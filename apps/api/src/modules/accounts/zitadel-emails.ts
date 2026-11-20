// SPDX-License-Identifier: AGPL-3.0-only
// Zitadel's copy of the login email (P2.7d, ADR 0057). The API checks the
// code sent to the new address; once it is right, the address is set in
// Zitadel as verified (user API v2, the clubadmin-api machine user with the
// instance role IAM_USER_MANAGER), then in accounts.

import { DomainError } from "../../platform/domain/domain-error.ts";
import type { IdentityProviderEmails } from "./accounts.service.ts";

export function zitadelEmails(baseUrl: string, token: string): IdentityProviderEmails {
  return {
    async setVerifiedEmail(userId, email) {
      const res = await fetch(
        `${baseUrl.replace(/\/$/, "")}/v2/users/${encodeURIComponent(userId)}/email`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ email, isVerified: true }),
        },
      );
      // Another Zitadel user has the address (unique emails are on for the instance).
      if (res.status === 409) throw new DomainError("email_taken");
      if (!res.ok) throw new Error(`Zitadel email change failed: HTTP ${res.status}`);
    },
  };
}
