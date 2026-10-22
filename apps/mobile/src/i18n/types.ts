// SPDX-License-Identifier: AGPL-3.0-only
// Typed message keys and locales for use-intl (a typo in a key fails the type check).

import type { Locale, Messages } from "@clubadmin/i18n";

declare module "use-intl" {
  interface AppConfig {
    Locale: Locale;
    Messages: Messages;
  }
}
