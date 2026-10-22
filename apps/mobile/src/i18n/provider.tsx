// SPDX-License-Identifier: AGPL-3.0-only
// Messages from @clubadmin/i18n through use-intl (next-intl's framework-free
// core), so web and mobile share message syntax and formatting.

import "./intl-polyfills.ts";

import { type Locale, withFallback } from "@clubadmin/i18n";
import type { ReactNode } from "react";
import { IntlProvider } from "use-intl";

export function I18nProvider({
  locale,
  timeZone,
  children,
}: {
  locale: Locale;
  timeZone: string;
  children: ReactNode;
}) {
  return (
    <IntlProvider locale={locale} timeZone={timeZone} messages={withFallback(locale)}>
      {children}
    </IntlProvider>
  );
}
