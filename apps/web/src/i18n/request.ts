// SPDX-License-Identifier: AGPL-3.0-only
// next-intl's request configuration: locale and time zone from the chain in
// src/server/context.ts, messages from packages/i18n (Norwegian with English
// fallback for missing keys).

import { withFallback } from "@clubadmin/i18n";
import { getRequestConfig } from "next-intl/server";

import { resolveLocale, resolveTimeZone } from "../server/context.ts";

export default getRequestConfig(async () => {
  const [locale, timeZone] = await Promise.all([resolveLocale(), resolveTimeZone()]);
  return { locale, timeZone, messages: withFallback(locale), now: new Date() };
});
