// SPDX-License-Identifier: AGPL-3.0-only
// Consent texts and the privacy policy in the reader's language (P1.8a).
// The platform's default texts and the policy template are messages
// (packages/i18n, `consentTexts.*` and `privacyPolicy.v<n>.*`); a club's
// own text is shown in the reader's language, else the club's, else any.

import { type Locale, localeOf } from "@clubadmin/i18n";
import { message } from "@clubadmin/server-kit/notifications";
import {
  type ConsentPurpose,
  type ConsentText,
  consentTextKey,
  DEFAULT_CONSENT_TEXT_VERSIONS,
  PRIVACY_POLICY_SECTIONS,
} from "@clubadmin/shared";

import type { ConsentTextRow } from "./privacy.repository.ts";

export function renderConsentText(
  locale: Locale,
  purpose: ConsentPurpose,
  clubText: ConsentTextRow | undefined,
  club: { name: string; defaultLocale: string },
): ConsentText {
  if (clubText) {
    const texts = clubText.texts;
    const clubLocale = localeOf(club.defaultLocale);
    const body =
      texts[locale] ?? (clubLocale ? texts[clubLocale] : undefined) ?? Object.values(texts)[0];
    return {
      textVersion: `club:${clubText.version}`,
      body: body ?? "",
      publishedAt: clubText.publishedAt.toISOString(),
    };
  }
  const version = DEFAULT_CONSENT_TEXT_VERSIONS[purpose];
  return {
    textVersion: `default:${version}`,
    body: message(locale, consentTextKey(purpose, version), { club: club.name }),
    publishedAt: null,
  };
}

/** A default text version, for the history of consents given to an older one. */
export function renderDefaultText(
  locale: Locale,
  purpose: ConsentPurpose,
  version: number,
  clubName: string,
): string {
  return message(locale, consentTextKey(purpose, version), { club: clubName });
}

export interface PolicyValues {
  club: string;
  organizationNumber: string;
  contact: string;
  formerMemberMonths: number;
  attendanceMonths: number;
  purposes: readonly ConsentPurpose[];
  auditMonths: number;
  historyMonths: number;
  orphanMonths: number;
}

/** The sections of a policy template version, rendered. */
export function renderPolicy(
  locale: Locale,
  templateVersion: number,
  values: PolicyValues,
): { key: string; title: string; body: string }[] {
  const purposeNames = values.purposes
    .map((p) => message(locale, `consentPurposes.${p}`, {}))
    .join(", ");
  const params: Record<string, string> = {
    club: values.club,
    organizationNumber: values.organizationNumber,
    contact: values.contact,
    formerMemberMonths: String(values.formerMemberMonths),
    attendanceMonths: String(values.attendanceMonths),
    purposes: purposeNames || message(locale, "privacyPolicy.noPurposes", {}),
    auditMonths: String(values.auditMonths),
    historyMonths: String(values.historyMonths),
    orphanMonths: String(values.orphanMonths),
  };
  return PRIVACY_POLICY_SECTIONS.map((key) => ({
    key,
    title: message(locale, `privacyPolicy.v${templateVersion}.${key}.title`, params),
    body: message(locale, `privacyPolicy.v${templateVersion}.${key}.body`, params),
  }));
}
