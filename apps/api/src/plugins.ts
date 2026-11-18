// SPDX-License-Identifier: AGPL-3.0-only
// The plugins bundled with this installation (P2.7, ADR 0051). The
// configuration's PLUGINS lists which of them are installed (empty: all);
// each club then enables the ones it wants. The grant plugins for Sweden
// (LOK) and Norway (LAM) are added in P2.7 part B.

import type { Plugin } from "@clubadmin/plugin-api";

export const BUNDLED_PLUGINS: readonly Plugin[] = [];
