// SPDX-License-Identifier: AGPL-3.0-only
// GET /me shows a planned account deletion (P1.8b). The identity module
// asks for it through this token, which the privacy module provides
// globally, so neither module imports the other (dependency-cruiser:
// no circular modules).

import type { ActorContext } from "@clubadmin/db";

export interface PendingDeletionLookup {
  pendingDeletion(context: ActorContext): Promise<{ scheduledFor: Date } | null>;
}

export const PENDING_DELETION = Symbol("PENDING_DELETION");
