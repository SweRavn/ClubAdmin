// SPDX-License-Identifier: AGPL-3.0-only
// Request locale for server components and route handlers (from
// Accept-Language until user and club preferences arrive in P0.9).

import { format, type Locale, type MessageKey, negotiateLocale } from "@clubadmin/i18n";
import { headers } from "next/headers";

export async function requestLocale(): Promise<Locale> {
  return negotiateLocale((await headers()).get("accept-language") ?? undefined);
}

export async function translator(): Promise<{
  locale: Locale;
  t: (key: MessageKey, values?: Record<string, string | number>) => string;
}> {
  const locale = await requestLocale();
  return { locale, t: (key, values) => format(locale, key, values) };
}
