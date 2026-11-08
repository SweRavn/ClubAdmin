// SPDX-License-Identifier: AGPL-3.0-only
// A series' rule and answer request in plain language for the web (P1.14),
// with the shared describeRecurrence and the viewer's catalogue.
import { describeRecurrence, type RecurrenceSummaryInput } from "@clubadmin/i18n";
import type { RequestLead } from "@clubadmin/shared";
import { formatDateTime } from "@clubadmin/ui";
import { getLocale, getTranslations } from "next-intl/server";

type Translate = (key: string, values?: Record<string, string | number>) => string;

export async function recurrenceText(input: RecurrenceSummaryInput): Promise<string> {
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const translate: Translate = (key, values) => t(key as never, values as never);
  return describeRecurrence(translate, locale, input, (date) =>
    formatDateTime(`${date}T12:00:00Z`, { locale, timeZone: "UTC", dateStyle: "long" }),
  );
}

export async function requestLeadText(lead: RequestLead): Promise<string> {
  const t = await getTranslations();
  return lead.kind === "days"
    ? t("recurrence.request.days", { days: lead.days, time: lead.time })
    : t("recurrence.request.hours", { hours: lead.hours });
}
