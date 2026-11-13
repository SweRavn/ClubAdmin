// SPDX-License-Identifier: AGPL-3.0-only
// Consent texts (P1.8a). The platform's default text of each purpose is a
// message (`consentTexts.<purpose>.v<n>` in packages/i18n, sv, en and nb);
// a released version is never edited (a test checks the committed hashes):
// a new wording is a new version. A club may publish its own versions
// (consent_texts). A consent records the version agreed to.

import type { ConsentPurpose } from "../domain/core.ts";

/** The current default version of each purpose's text. */
export const DEFAULT_CONSENT_TEXT_VERSIONS: Record<ConsentPurpose, number> = {
  photo_publication: 1,
  video_publication: 1,
  streaming: 1,
  marketing: 1,
  federation_sharing: 1,
  contacts_group: 1,
  contacts_club: 1,
};

/** The message key of a default text version. */
export const consentTextKey = (purpose: ConsentPurpose, version: number) =>
  `consentTexts.${purpose}.v${version}`;

export type TextVersion = `default:${number}` | `club:${number}`;

export const defaultTextVersion = (n: number): TextVersion => `default:${n}`;
export const clubTextVersion = (n: number): TextVersion => `club:${n}`;

export function parseTextVersion(
  value: string,
): { source: "default" | "club"; version: number } | null {
  const match = /^(default|club):([1-9][0-9]*)$/.exec(value);
  return match ? { source: match[1] as "default" | "club", version: Number(match[2]) } : null;
}

/** The privacy policy template's current version (messages `privacyPolicy.v<n>.*`). */
/** v2 (P2.1 part C) adds the chat section (child safety, reports, what is kept). */
export const PRIVACY_POLICY_TEMPLATE_VERSION = 2;

/** The sections of a policy template, in order (messages `privacyPolicy.v<n>.<section>.title|body`). */
export const PRIVACY_POLICY_SECTIONS = [
  "controller",
  "data",
  "purposes",
  "consents",
  "retention",
  "recipients",
  "rights",
  "contact",
  // From template version 2 (P2.1 part C).
  "chat",
] as const;
export type PrivacyPolicySection = (typeof PRIVACY_POLICY_SECTIONS)[number];

/** The sections a template version has (earlier versions keep theirs). */
export const privacyPolicySections = (templateVersion: number): readonly PrivacyPolicySection[] =>
  templateVersion >= 2
    ? PRIVACY_POLICY_SECTIONS
    : PRIVACY_POLICY_SECTIONS.filter((s) => s !== "chat");
