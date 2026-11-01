// SPDX-License-Identifier: AGPL-3.0-only
// Who may give and withdraw a consent (P1.8a, ADR 0041), as pure functions:
// - the person themselves from the country pack's consent age;
// - a full guardian (parent, legal guardian with act_on_behalf) gives for a
//   ward below the consent age and withdraws until the adult age; a consent
//   given before the consent age stays until someone withdraws it;
// - registrars and club managers record a paper consent (with a note) and
//   withdraw on request;
// - nobody gives a purpose the club does not ask for, or a photo, video,
//   streaming or contact purpose for a protected person.

import { ageOn, type AgeRules } from "@clubadmin/country-packs";
import {
  type ConsentPurpose,
  DEFAULT_CONSENT_TEXT_VERSIONS,
  PROTECTED_INAPPLICABLE_PURPOSES,
} from "@clubadmin/shared";

export type ConsentCaller = "self" | "guardian" | "admin";

export interface ConsentFacts {
  purpose: ConsentPurpose;
  /** The club asks for this purpose. */
  asked: boolean;
  /** Effective protected identity of the person in the club. */
  protected: boolean;
  /** Birth date of the person (null: unknown, treated as an adult). */
  birthDate: string | null;
  ageRules: AgeRules;
  /** An open consent exists. */
  open: boolean;
}

export const isApplicable = (purpose: ConsentPurpose, isProtected: boolean) =>
  !(isProtected && (PROTECTED_INAPPLICABLE_PURPOSES as readonly string[]).includes(purpose));

export function consentRights(
  caller: ConsentCaller,
  facts: ConsentFacts,
  now: Date = new Date(),
): { mayGive: boolean; mayWithdraw: boolean } {
  const age = facts.birthDate ? ageOn(facts.birthDate, now) : Number.POSITIVE_INFINITY;
  const canGive = facts.asked && isApplicable(facts.purpose, facts.protected) && !facts.open;
  switch (caller) {
    case "self":
      return {
        mayGive: canGive && age >= facts.ageRules.consentAge,
        mayWithdraw: facts.open && age >= facts.ageRules.consentAge,
      };
    case "guardian":
      return {
        mayGive: canGive && age < facts.ageRules.consentAge,
        mayWithdraw: facts.open && age < facts.ageRules.adultAge,
      };
    case "admin":
      return { mayGive: canGive, mayWithdraw: facts.open };
  }
}

/** Why giving is refused (a domain error code), or null if allowed. */
export function giveRefusal(
  caller: ConsentCaller,
  facts: Omit<ConsentFacts, "open">,
  now: Date = new Date(),
): "consent_purpose_not_asked" | "consent_not_applicable" | "consent_age_required" | null {
  if (!facts.asked) return "consent_purpose_not_asked";
  if (!isApplicable(facts.purpose, facts.protected)) return "consent_not_applicable";
  if (caller === "admin") return null;
  const { mayGive } = consentRights(caller, { ...facts, open: false }, now);
  return mayGive ? null : "consent_age_required";
}

/** The current text version of a purpose: the club's latest, else the platform default. */
export function currentTextVersion(purpose: ConsentPurpose, clubVersion: number | null): string {
  return clubVersion ? `club:${clubVersion}` : `default:${DEFAULT_CONSENT_TEXT_VERSIONS[purpose]}`;
}
