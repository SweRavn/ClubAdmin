// SPDX-License-Identifier: AGPL-3.0-only
// The public handle of an app session in the sessions list, derived from the
// identity provider's session (Zitadel sid), so it is stable across token
// refreshes. Here in the platform layer because the identity module (the
// sessions list) and the notifications module (push devices) both use it.

import { createHash } from "node:crypto";

export const mobileSessionHandle = (idpSessionId: string) =>
  `m-${createHash("sha256").update(idpSessionId).digest("base64url").slice(0, 22)}`;
