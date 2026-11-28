// SPDX-License-Identifier: AGPL-3.0-only
// The plugins bundled with this installation (P2.7, ADR 0051). The
// configuration's PLUGINS lists which of them are installed (empty: all);
// each club then enables the ones it wants: Sweden's LOK-stöd and Norway's
// samordnet rapportering, the basis of LAM (P2.7 part B); the background
// checks of Sweden and Norway (P2.8), on by default in their country.

import type { Plugin } from "@clubadmin/plugin-api";
import { noBackgroundCheck } from "@clubadmin/plugin-no-background-check";
import { noLam } from "@clubadmin/plugin-no-lam";
import { seBackgroundCheck } from "@clubadmin/plugin-se-background-check";
import { seLok } from "@clubadmin/plugin-se-lok";

export const BUNDLED_PLUGINS: readonly Plugin[] = [
  seLok,
  noLam,
  seBackgroundCheck,
  noBackgroundCheck,
];
