// SPDX-License-Identifier: AGPL-3.0-only
// Type-checked message keys and locales for next-intl.

import type { Locale, Messages } from "@clubadmin/i18n";
import type {} from "next-intl";

declare module "next-intl" {
  interface AppConfig {
    Locale: Locale;
    Messages: Messages;
  }
}
