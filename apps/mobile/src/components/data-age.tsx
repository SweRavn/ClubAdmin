// SPDX-License-Identifier: AGPL-3.0-only
// "Saved at 14:05" under data shown from the cache that is older than a few
// minutes (offline, or before the background refresh finished).

import { useFormatter } from "use-intl";
import { useTranslations } from "use-intl";

import { Muted } from "./ui.tsx";

/** Data older than this is labelled with its age. */
export const STALE_NOTICE_MS = 15 * 60_000;

export function DataAge({ updatedAt, now = Date.now() }: { updatedAt: number; now?: number }) {
  const t = useTranslations("mobile");
  const format = useFormatter();
  if (!updatedAt || now - updatedAt < STALE_NOTICE_MS) return null;
  const sameDay = new Date(updatedAt).toDateString() === new Date(now).toDateString();
  const time = format.dateTime(
    new Date(updatedAt),
    sameDay ? { timeStyle: "short" } : { dateStyle: "medium", timeStyle: "short" },
  );
  return <Muted testID="data-age">{t("savedAt", { time })}</Muted>;
}
