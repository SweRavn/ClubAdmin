// SPDX-License-Identifier: AGPL-3.0-only
// A moment in the club's time zone, with the viewer's time when it differs
// (docs/architecture.md, "Locale").

import { DateTime } from "@clubadmin/ui";
import { getLocale, getTranslations } from "next-intl/server";

import { viewerTimeZone } from "../server/context.ts";

export async function ClubTime({
  value,
  timeZone,
  dateStyle,
  timeStyle,
}: {
  value: Date | string;
  timeZone: string;
  dateStyle?: "full" | "long" | "medium" | "short";
  timeStyle?: "full" | "long" | "medium" | "short";
}) {
  const [t, locale, viewer] = await Promise.all([getTranslations(), getLocale(), viewerTimeZone()]);
  return (
    <DateTime
      value={value}
      locale={locale}
      timeZone={timeZone}
      {...(dateStyle ? { dateStyle } : {})}
      {...(timeStyle ? { timeStyle } : {})}
      viewerTimeZone={viewer}
      renderViewerTime={(time, zone) => t("time.viewerZone", { time, zone })}
    />
  );
}
